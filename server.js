const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const crypto = require('crypto');
const {
    createDeck,
    shuffleDeck,
    dealCards,
    determinePotWinners,
} = require('./pokerEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static('public'));

// ─── In-memory state ───────────────────────────────────────────
const rooms = {}; // roomCode -> Room

const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

// ─── Helpers ───────────────────────────────────────────────────
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms[code] ? generateRoomCode() : code;
}

function generatePlayerToken() {
    return crypto.randomBytes(32).toString('hex');
}

function serializeCard(card) {
    if (!card) return null;
    return { rank: card.rank, suit: card.suit };
}

function createRoom(hostId, hostName) {
    const code = generateRoomCode();
    rooms[code] = {
        code,
        hostId,
        hostToken: null,
        players: [],
        dealerIndex: 0,
        currentTurnIndex: -1,
        pot: 0,
        currentBet: 0,
        minRaise: BIG_BLIND,
        roundStage: null, // null | 'pre-flop' | 'flop' | 'turn' | 'river'
        roundActive: false,
        actionLog: [],
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        startingChips: STARTING_CHIPS,
        deck: [],
        board: [],
        handId: 0,
        stateVersion: 0,
        actionQueue: [],
        processingAction: false,
        pendingToAct: new Set(),
        lastResult: null,
        lastAnnouncedHandId: -1,
    };
    const host = addPlayer(code, hostId, hostName);
    if (host && host.token) {
        rooms[code].hostToken = host.token;
    }
    return rooms[code];
}

function addPlayer(code, id, name) {
    const room = rooms[code];
    if (!room) return null;
    // check duplicate name
    if (room.players.find(p => p.name.toLowerCase() === name.toLowerCase())) return 'NAME_TAKEN';
    const token = generatePlayerToken();
    const player = {
        id,
        token,
        name,
        chips: room.startingChips,
        currentBet: 0,
        totalRoundBet: 0,
        handBet: 0,
        holeCards: [],
        folded: false,
        allIn: false,
        eliminated: false,
        connected: true,
    };
    room.players.push(player);
    return player;
}

function getActivePlayers(room) {
    return room.players.filter(p => !p.folded && !p.eliminated);
}

function getNonEliminatedPlayers(room) {
    return room.players.filter(p => !p.eliminated);
}

function getActablePlayers(room) {
    return room.players.filter(p => !p.folded && !p.eliminated && !p.allIn);
}

function getNextNonEliminatedIndex(room, fromIndex) {
    const total = room.players.length;
    let idx = (fromIndex + 1) % total;
    let loops = 0;
    while (loops < total) {
        const p = room.players[idx];
        if (!p.eliminated) return idx;
        idx = (idx + 1) % total;
        loops++;
    }
    return -1;
}

function getNextActableIndex(room, fromIndex) {
    const total = room.players.length;
    let idx = (fromIndex + 1) % total;
    let loops = 0;
    while (loops < total) {
        const p = room.players[idx];
        if (!p.folded && !p.eliminated && !p.allIn) return idx;
        idx = (idx + 1) % total;
        loops++;
    }
    return -1; // no active player found
}

function getNextPendingIndex(room, fromIndex) {
    if (!room.pendingToAct || room.pendingToAct.size === 0) return -1;
    const total = room.players.length;
    let idx = fromIndex;
    let loops = 0;
    while (loops < total) {
        idx = (idx + 1) % total;
        const p = room.players[idx];
        if (p && room.pendingToAct.has(p.id) && !p.folded && !p.eliminated && !p.allIn) {
            return idx;
        }
        loops++;
    }
    return -1;
}

function resetBetsForNewStage(room) {
    room.players.forEach(p => {
        p.currentBet = 0;
        p.totalRoundBet = 0;
    });
    room.currentBet = 0;
    room.minRaise = room.bigBlind;
}

function setPendingToAct(room) {
    room.pendingToAct = new Set(getActablePlayers(room).map(p => p.id));
}

function setCurrentTurnFromIndex(room, startIndex) {
    if (!room.pendingToAct || room.pendingToAct.size === 0) {
        room.currentTurnIndex = -1;
        return;
    }
    if (startIndex >= 0) {
        const candidate = room.players[startIndex];
        if (candidate && room.pendingToAct.has(candidate.id) && !candidate.folded && !candidate.eliminated && !candidate.allIn) {
            room.currentTurnIndex = startIndex;
            return;
        }
    }
    room.currentTurnIndex = getNextPendingIndex(room, startIndex < 0 ? 0 : startIndex);
}

function markEliminated(room) {
    room.players.forEach(p => {
        if (p.chips <= 0 && !p.eliminated) {
            p.eliminated = true;
            p.chips = 0;
        }
    });
}

function awardSingleWinner(room, winner) {
    const amount = room.pot;
    if (amount > 0) {
        winner.chips += amount;
    }
    room.pot = 0;
    room.roundActive = false;
    room.roundStage = 'showdown';
    room.currentTurnIndex = -1;
    room.pendingToAct = new Set();
    room.lastResult = {
        handId: room.handId,
        totalPot: amount,
        awards: [{ id: winner.id, name: winner.name, amount }],
        board: room.board.map(serializeCard),
    };
    room.actionLog.push({
        type: 'round-end',
        winners: [{ name: winner.name, amount }],
        timestamp: Date.now()
    });
    markEliminated(room);
}

function resolveShowdown(room) {
    const result = determinePotWinners(room.players, room.board, room.dealerIndex);
    const awards = new Map();

    result.pots.forEach(pot => {
        if (!pot.winners.length) return;
        const share = Math.floor(pot.amount / pot.winners.length);
        const remainder = pot.amount - (share * pot.winners.length);

        pot.winners.forEach(id => {
            awards.set(id, (awards.get(id) || 0) + share);
        });

        if (remainder > 0 && pot.winners.length > 0) {
            const remainderRecipient = result.seatOrder.find(id => pot.winners.includes(id)) || pot.winners[0];
            if (remainderRecipient) {
                awards.set(remainderRecipient, (awards.get(remainderRecipient) || 0) + remainder);
            }
        }
    });

    const winners = [];
    awards.forEach((amount, id) => {
        const player = room.players.find(p => p.id === id);
        if (player) {
            player.chips += amount;
            winners.push({
                id,
                name: player.name,
                amount,
                hand: result.handRanks[id] ? result.handRanks[id].name : null
            });
        }
    });

    const totalPot = room.pot;
    room.pot = 0;
    room.roundActive = false;
    room.roundStage = 'showdown';
    room.currentTurnIndex = -1;
    room.pendingToAct = new Set();
    room.lastResult = {
        handId: room.handId,
        totalPot,
        pots: result.pots.map(pot => ({
            amount: pot.amount,
            winners: pot.winners,
            bestHand: pot.bestHand,
        })),
        awards: winners,
        board: room.board.map(serializeCard),
    };

    room.actionLog.push({
        type: 'round-end',
        winners: winners.map(w => ({ name: w.name, amount: w.amount, hand: w.hand })),
        timestamp: Date.now()
    });

    markEliminated(room);
}

function runOutBoard(room) {
    const stages = ['pre-flop', 'flop', 'turn', 'river'];
    while (room.roundStage !== 'river') {
        const currentIdx = stages.indexOf(room.roundStage);
        if (currentIdx === -1 || currentIdx >= stages.length - 1) break;
        if (room.roundStage === 'pre-flop') {
            room.board.push(...dealCards(room.deck, 3));
        } else {
            room.board.push(...dealCards(room.deck, 1));
        }
        room.roundStage = stages[currentIdx + 1];
        room.actionLog.push({
            type: 'stage',
            stage: room.roundStage,
            board: room.board.map(serializeCard),
            timestamp: Date.now()
        });
    }
}

function resolveAllIn(room) {
    runOutBoard(room);
    resolveShowdown(room);
}

function advanceRoundStage(room) {
    const stages = ['pre-flop', 'flop', 'turn', 'river'];
    const currentIdx = stages.indexOf(room.roundStage);
    if (currentIdx === -1) return;
    if (currentIdx >= stages.length - 1) {
        resolveShowdown(room);
        return;
    }

    if (room.roundStage === 'pre-flop') {
        room.board.push(...dealCards(room.deck, 3));
    } else {
        room.board.push(...dealCards(room.deck, 1));
    }

    room.roundStage = stages[currentIdx + 1];
    resetBetsForNewStage(room);
    setPendingToAct(room);

    if (room.pendingToAct.size === 0) {
        resolveAllIn(room);
        return;
    }

    const firstIdx = getNextActableIndex(room, room.dealerIndex);
    setCurrentTurnFromIndex(room, firstIdx);

    room.actionLog.push({
        type: 'stage',
        stage: room.roundStage,
        board: room.board.map(serializeCard),
        timestamp: Date.now()
    });
}

function advanceAfterAction(room) {
    const remaining = getActivePlayers(room);
    if (remaining.length === 1) {
        awardSingleWinner(room, remaining[0]);
        return;
    }

    if (getActablePlayers(room).length === 0) {
        resolveAllIn(room);
        return;
    }

    if (!room.pendingToAct || room.pendingToAct.size === 0) {
        advanceRoundStage(room);
        return;
    }

    const nextIdx = getNextPendingIndex(room, room.currentTurnIndex);
    if (nextIdx === -1) {
        advanceRoundStage(room);
        return;
    }

    room.currentTurnIndex = nextIdx;
}

function applyAutoActions(room) {
    let iterationCount = 0;
    const maxIterations = room.players.length;
    while (room.roundActive && room.pendingToAct && room.pendingToAct.size > 0 && iterationCount < maxIterations) {
        if (room.currentTurnIndex === -1) {
            room.currentTurnIndex = getNextPendingIndex(room, 0);
            if (room.currentTurnIndex === -1) break;
        }
        const player = room.players[room.currentTurnIndex];
        if (!player || player.folded || player.eliminated || player.allIn) {
            room.currentTurnIndex = getNextPendingIndex(room, room.currentTurnIndex);
            iterationCount += 1;
            continue;
        }

        if (player.connected) break;

        const toCall = room.currentBet - player.totalRoundBet;
        const action = toCall > 0 ? 'fold' : 'check';
        handleAction(room, player.id, action, null, { auto: true, skipAutoActions: true });
        iterationCount += 1;
    }
}

function commitBet(room, player, amount) {
    if (!amount || amount <= 0) return 0;
    const wager = Math.min(amount, player.chips);
    player.chips -= wager;
    player.currentBet += wager;
    player.totalRoundBet += wager;
    player.handBet += wager;
    room.pot += wager;
    if (player.chips === 0) player.allIn = true;
    return wager;
}

function startRound(room) {
    const eligible = getNonEliminatedPlayers(room);
    if (eligible.length < 2) return false;

    room.handId += 1;
    // Reset player states
    room.players.forEach(p => {
        p.folded = p.eliminated;
        p.allIn = false;
        p.currentBet = 0;
        p.totalRoundBet = 0;
        p.handBet = 0;
        p.holeCards = [];
    });

    room.pot = 0;
    room.currentBet = 0;
    room.minRaise = room.bigBlind;
    room.roundStage = 'pre-flop';
    room.roundActive = true;
    room.actionLog = [];
    room.board = [];
    room.deck = shuffleDeck(createDeck());
    room.lastResult = null;

    // Rotate dealer
    const nextDealer = getNextNonEliminatedIndex(room, room.dealerIndex);
    room.dealerIndex = nextDealer === -1 ? 0 : nextDealer;

    // Deal hole cards
    room.players.forEach(p => {
        if (!p.eliminated) {
            p.holeCards = dealCards(room.deck, 2);
        }
    });

    // Post blinds
    const sbIdx = getNextActableIndex(room, room.dealerIndex);
    const bbIdx = getNextActableIndex(room, sbIdx);

    const sbPlayer = room.players[sbIdx];
    const bbPlayer = room.players[bbIdx];

    // Small blind
    const sbAmount = Math.min(room.smallBlind, sbPlayer.chips);
    commitBet(room, sbPlayer, sbAmount);

    // Big blind
    const bbAmount = Math.min(room.bigBlind, bbPlayer.chips);
    commitBet(room, bbPlayer, bbAmount);
    room.currentBet = bbPlayer.totalRoundBet;

    // First to act is after big blind
    setPendingToAct(room);
    if (room.pendingToAct.size === 0) {
        resolveAllIn(room);
        return { sbIdx, bbIdx, dealerIdx: room.dealerIndex };
    }
    const firstIdx = getNextActableIndex(room, bbIdx);
    setCurrentTurnFromIndex(room, firstIdx);

    room.actionLog.push({
        type: 'blinds',
        smallBlind: { name: sbPlayer.name, amount: sbAmount },
        bigBlind: { name: bbPlayer.name, amount: bbAmount },
        dealer: room.players[room.dealerIndex].name,
        timestamp: Date.now()
    });

    applyAutoActions(room);

    return { sbIdx, bbIdx, dealerIdx: room.dealerIndex };
}

function handleAction(room, playerId, action, amount, options = {}) {
    const playerIdx = room.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1) return { error: 'Player not found' };
    if (!room.roundActive) return { error: 'No active round' };

    const player = room.players[playerIdx];
    if (!options.auto && playerIdx !== room.currentTurnIndex) return { error: 'Not your turn' };
    if (player.folded || player.eliminated) return { error: 'Player is not active' };
    if (player.allIn) return { error: 'Player is already all-in' };
    if (!player.connected && !options.auto) return { error: 'Player is disconnected' };

    const toCall = Math.max(0, room.currentBet - player.totalRoundBet);
    let logEntry = { type: 'action', player: player.name, action, timestamp: Date.now(), auto: !!options.auto };

    switch (action) {
        case 'fold':
            player.folded = true;
            logEntry.detail = 'folded';
            break;

        case 'check':
            if (toCall > 0) return { error: 'Cannot check, must call, raise, or fold' };
            logEntry.detail = 'checked';
            break;

        case 'call': {
            if (toCall <= 0) return { error: 'Nothing to call, use check' };
            if (player.chips <= 0) return { error: 'No chips to call' };
            const callAmount = commitBet(room, player, toCall);
            logEntry.detail = `called ${callAmount}`;
            logEntry.amount = callAmount;
            if (player.allIn) logEntry.detail += ' (all-in)';
            break;
        }

        case 'raise': {
            let raiseAmount = Number(amount);
            if (!Number.isFinite(raiseAmount) || raiseAmount <= 0) {
                return { error: 'Invalid raise amount' };
            }
            if (raiseAmount <= toCall) {
                return { error: `Raise must exceed call of ${toCall} chips` };
            }
            if (raiseAmount > player.chips) raiseAmount = player.chips;

            const totalAfter = player.totalRoundBet + raiseAmount;
            if (totalAfter <= room.currentBet) return { error: 'Raise must exceed current bet' };

            const raiseSize = totalAfter - room.currentBet;
            const isAllIn = raiseAmount >= player.chips;
            if (raiseSize < room.minRaise && !isAllIn) {
                const minRaiseTotal = room.minRaise + toCall;
                return { error: `Minimum raise amount is ${minRaiseTotal} chips` };
            }

            const committed = commitBet(room, player, raiseAmount);
            room.currentBet = player.totalRoundBet;
            if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
            room.pendingToAct = new Set(getActablePlayers(room).filter(p => p.id !== player.id).map(p => p.id));

            logEntry.detail = `raised to ${room.currentBet}`;
            logEntry.amount = committed;
            if (player.allIn) logEntry.detail += ' (all-in)';
            break;
        }

        case 'all-in': {
            if (player.chips <= 0) return { error: 'No chips to go all-in' };
            const allInAmount = player.chips;
            const totalAfter = player.totalRoundBet + allInAmount;
            const raiseSize = totalAfter - room.currentBet;
            const committed = commitBet(room, player, allInAmount);

            if (totalAfter > room.currentBet) {
                room.currentBet = totalAfter;
                if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
                room.pendingToAct = new Set(getActablePlayers(room).filter(p => p.id !== player.id).map(p => p.id));
                logEntry.detail = `all-in to ${room.currentBet}`;
            } else {
                logEntry.detail = `all-in for ${committed}`;
            }
            logEntry.amount = committed;
            break;
        }

        default:
            return { error: 'Unknown action' };
    }

    if (room.pendingToAct) {
        room.pendingToAct.delete(player.id);
    }

    room.actionLog.push(logEntry);
    advanceAfterAction(room);

    if (!options.skipAutoActions) {
        applyAutoActions(room);
    }

    return { success: true, logEntry };
}

function endRound(room, winnerIds) {
    return { error: 'Manual pot award is disabled. Showdowns resolve automatically.' };
}

function getRoomState(room, forPlayerId) {
    const isShowdown = room.roundStage === 'showdown';
    return {
        code: room.code,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            chips: p.chips,
            currentBet: p.totalRoundBet,
            folded: p.folded,
            allIn: p.allIn,
            eliminated: p.eliminated,
            connected: p.connected,
            isYou: p.id === forPlayerId,
            holeCards: p.id === forPlayerId || (isShowdown && !p.folded && !p.eliminated)
                ? p.holeCards.map(serializeCard)
                : [],
            cardCount: p.holeCards.length,
        })),
        pot: room.pot,
        currentBet: room.currentBet,
        minRaise: room.minRaise,
        currentTurnIndex: room.currentTurnIndex,
        dealerIndex: room.dealerIndex,
        roundStage: room.roundStage,
        roundActive: room.roundActive,
        hostId: room.hostId,
        actionLog: room.actionLog.slice(-20),
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        board: room.board.map(serializeCard),
        handId: room.handId,
        stateVersion: room.stateVersion,
        lastResult: room.lastResult,
    };
}

function broadcastRoomState(room) {
    room.stateVersion += 1;
    room.players.forEach(p => {
        if (p.connected) {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        }
    });
}

function enqueueRoomAction(room, actionFn) {
    room.actionQueue.push(actionFn);
    if (room.processingAction) return;
    room.processingAction = true;
    while (room.actionQueue.length > 0) {
        const next = room.actionQueue.shift();
        try {
            next();
        } catch (err) {
            console.error('Room action failed:', err);
        }
    }
    room.processingAction = false;
}

function emitToast(roomCode, message, type) {
    io.to(roomCode).emit('toast', { message, type });
}

function announceWinnersIfNeeded(room) {
    if (!room.lastResult || room.lastResult.handId === room.lastAnnouncedHandId) return;
    const awards = room.lastResult.awards || [];
    if (!awards.length) return;
    const summary = awards.map(winner => {
        const handText = winner.hand ? ` (${winner.hand})` : '';
        return `${winner.name} (+${winner.amount})${handText}`;
    }).join(', ');
    emitToast(room.code, `🏆 ${summary}`, 'win');
    room.lastAnnouncedHandId = room.lastResult.handId;
}

// ─── Socket.io Events ──────────────────────────────────────────
io.on('connection', (socket) => {
    let currentRoom = null;
    let playerName = null;

    socket.on('create-room', (data, callback) => {
        const name = (data.name || '').trim();
        if (!name) return callback({ error: 'Name is required' });

        const room = createRoom(socket.id, name);
        currentRoom = room.code;
        playerName = name;
        socket.join(room.code);

        const player = room.players.find(p => p.id === socket.id);
        callback({ success: true, roomCode: room.code, token: player ? player.token : null });
        broadcastRoomState(room);
    });

    socket.on('join-room', (data, callback) => {
        const code = (data.code || '').trim().toUpperCase();
        const name = (data.name || '').trim();

        if (!code || !name) return callback({ error: 'Room code and name are required' });

        const room = rooms[code];
        if (!room) return callback({ error: 'Room not found' });
        enqueueRoomAction(room, () => {
            if (room.roundActive) return callback({ error: 'Cannot join during an active round' });

            const result = addPlayer(code, socket.id, name);
            if (result === 'NAME_TAKEN') return callback({ error: 'That name is already taken' });
            if (!result) return callback({ error: 'Failed to join room' });

            currentRoom = code;
            playerName = name;
            socket.join(code);

            callback({ success: true, roomCode: code, token: result.token });
            broadcastRoomState(room);
            emitToast(code, `${name} joined the table`, 'info');
        });
    });

    socket.on('resume-session', (data, callback) => {
        const code = (data.code || '').trim().toUpperCase();
        const token = (data.token || '').trim();

        if (!code || !token) return callback({ error: 'Missing session info' });

        const room = rooms[code];
        if (!room) return callback({ error: 'Room not found' });

        enqueueRoomAction(room, () => {
            const player = room.players.find(p => p.token === token);
            if (!player) return callback({ error: 'Session expired' });

            if (player.connected && player.id !== socket.id) {
                io.to(player.id).emit('kicked');
            }

            player.id = socket.id;
            player.connected = true;
            currentRoom = code;
            playerName = player.name;
            socket.join(code);

            if (player.token === room.hostToken) {
                room.hostId = socket.id;
            }

            callback({ success: true, roomCode: code, token: player.token, isHost: room.hostId === socket.id });
            broadcastRoomState(room);
            emitToast(code, `${player.name} reconnected`, 'info');
        });
    });

    socket.on('start-round', (callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        enqueueRoomAction(room, () => {
            if (socket.id !== room.hostId) return callback({ error: 'Only the host can start a round' });
            if (room.roundActive) return callback({ error: 'Round already active' });

            const result = startRound(room);
            if (!result) return callback({ error: 'Need at least 2 players' });

            callback({ success: true });
            broadcastRoomState(room);

            const dealer = room.players[result.dealerIdx].name;
            emitToast(currentRoom, `New hand! Dealer: ${dealer}`, 'deal');
        });
    });

    socket.on('player-action', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        enqueueRoomAction(room, () => {
            const result = handleAction(room, socket.id, data.action, data.amount);
            if (result.error) return callback({ error: result.error });

            callback({ success: true });
            broadcastRoomState(room);

            if (result.logEntry && !result.logEntry.auto) {
                emitToast(currentRoom, `${result.logEntry.player} ${result.logEntry.detail}`, data.action);
            }

            announceWinnersIfNeeded(room);
        });
    });

    socket.on('end-round', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        enqueueRoomAction(room, () => {
            const result = endRound(room, data && data.winnerIds ? data.winnerIds : []);
            if (result.error) return callback({ error: result.error });
            callback({ success: true });
            broadcastRoomState(room);
        });
    });

    socket.on('reset-game', (callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        if (socket.id !== room.hostId) return callback({ error: 'Only the host can reset' });

        enqueueRoomAction(room, () => {
            room.players.forEach(p => {
                p.chips = room.startingChips;
                p.folded = false;
                p.allIn = false;
                p.eliminated = false;
                p.currentBet = 0;
                p.totalRoundBet = 0;
                p.handBet = 0;
                p.holeCards = [];
            });
            room.pot = 0;
            room.currentBet = 0;
            room.roundActive = false;
            room.roundStage = null;
            room.currentTurnIndex = -1;
            room.dealerIndex = 0;
            room.actionLog = [];
            room.board = [];
            room.deck = [];
            room.handId = 0;
            room.lastResult = null;
            room.pendingToAct = new Set();
            room.lastAnnouncedHandId = -1;

            callback({ success: true });
            broadcastRoomState(room);
            emitToast(currentRoom, 'Game reset! All chips restored.', 'info');
        });
    });

    socket.on('kick-player', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        enqueueRoomAction(room, () => {
            if (socket.id !== room.hostId) return callback({ error: 'Only the host can kick players' });
            if (room.roundActive) return callback({ error: 'Cannot kick players during an active round' });

            const targetIdx = room.players.findIndex(p => p.id === data.playerId);
            if (targetIdx === -1) return callback({ error: 'Player not found' });
            if (room.players[targetIdx].id === room.hostId) return callback({ error: 'Cannot kick the host' });

            const kicked = room.players[targetIdx];
            io.to(kicked.id).emit('kicked');
            room.players.splice(targetIdx, 1);

            if (room.dealerIndex >= room.players.length) {
                room.dealerIndex = 0;
            } else if (targetIdx <= room.dealerIndex && room.dealerIndex > 0) {
                room.dealerIndex -= 1;
            }

            room.currentTurnIndex = -1;

            callback({ success: true });
            broadcastRoomState(room);
            emitToast(currentRoom, `${kicked.name} was removed from the table`, 'info');
        });
    });

    socket.on('disconnect', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (!room) return;
        enqueueRoomAction(room, () => {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.connected = false;
                if (room.roundActive && room.currentTurnIndex === room.players.indexOf(player)) {
                    applyAutoActions(room);
                }
                broadcastRoomState(room);
                emitToast(currentRoom, `${player.name} disconnected`, 'warning');
                announceWinnersIfNeeded(room);
            }

            // Clean up empty rooms
            const connected = room.players.filter(p => p.connected);
            if (connected.length === 0) {
                delete rooms[currentRoom];
            }
        });
    });
});

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  ♠ ♥ ♦ ♣  POKLER — Poker Companion  ♣ ♦ ♥ ♠');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Local:    http://localhost:${PORT}`);
    console.log(`  Network:  http://${ip}:${PORT}`);
    console.log('  ─────────────────────────────────────────────');
    console.log('  Share the Network URL with your friends!');
    console.log('');
});
