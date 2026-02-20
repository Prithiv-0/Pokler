const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

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

function createRoom(hostId, hostName) {
    const code = generateRoomCode();
    rooms[code] = {
        code,
        hostId,
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
    };
    addPlayer(code, hostId, hostName);
    return rooms[code];
}

function addPlayer(code, id, name) {
    const room = rooms[code];
    if (!room) return null;
    // check duplicate name
    if (room.players.find(p => p.name.toLowerCase() === name.toLowerCase())) return 'NAME_TAKEN';
    const player = {
        id,
        name,
        chips: room.startingChips,
        currentBet: 0,
        totalRoundBet: 0,
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

function getNextActiveIndex(room, fromIndex) {
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

function advanceTurn(room) {
    const nextIdx = getNextActiveIndex(room, room.currentTurnIndex);

    // Check if betting round is over
    const active = getActivePlayers(room);
    const canAct = active.filter(p => !p.allIn);

    if (canAct.length <= 1) {
        // Check if all active non-allin players have matched the bet
        const allMatched = canAct.every(p => p.totalRoundBet === room.currentBet);
        if (allMatched || canAct.length === 0) {
            advanceRoundStage(room);
            return;
        }
    }

    // Check if we've gone around and everyone has acted
    if (nextIdx === -1) {
        advanceRoundStage(room);
        return;
    }

    // Check if next player has already matched and it's back to the raiser
    const nextPlayer = room.players[nextIdx];
    if (nextPlayer.totalRoundBet === room.currentBet && room.actionLog.length > 0) {
        // Everyone has had a chance to act and matched
        const activeNonAllIn = active.filter(p => !p.allIn);
        const allMatched = activeNonAllIn.every(p => p.totalRoundBet === room.currentBet);
        if (allMatched && activeNonAllIn.length > 0) {
            advanceRoundStage(room);
            return;
        }
    }

    room.currentTurnIndex = nextIdx;
}

function advanceRoundStage(room) {
    const stages = ['pre-flop', 'flop', 'turn', 'river'];
    const currentIdx = stages.indexOf(room.roundStage);

    // Reset per-round bets
    room.players.forEach(p => {
        p.currentBet = 0;
        p.totalRoundBet = 0;
    });
    room.currentBet = 0;
    room.minRaise = room.bigBlind;

    if (currentIdx >= stages.length - 1) {
        // River is done — round over, waiting for dealer to pick winner
        room.roundStage = 'showdown';
        room.currentTurnIndex = -1;
        return;
    }

    room.roundStage = stages[currentIdx + 1];

    // Set turn to first active player after dealer
    room.currentTurnIndex = getNextActiveIndex(room, room.dealerIndex);

    room.actionLog.push({
        type: 'stage',
        stage: room.roundStage,
        timestamp: Date.now()
    });
}

function startRound(room) {
    const eligible = getNonEliminatedPlayers(room);
    if (eligible.length < 2) return false;

    // Reset player states
    room.players.forEach(p => {
        p.folded = p.eliminated;
        p.allIn = false;
        p.currentBet = 0;
        p.totalRoundBet = 0;
    });

    room.pot = 0;
    room.currentBet = 0;
    room.minRaise = room.bigBlind;
    room.roundStage = 'pre-flop';
    room.roundActive = true;
    room.actionLog = [];

    // Rotate dealer
    let dIdx = room.dealerIndex;
    do {
        dIdx = (dIdx + 1) % room.players.length;
    } while (room.players[dIdx].eliminated);
    room.dealerIndex = dIdx;

    // Post blinds
    const sbIdx = getNextActiveIndex(room, room.dealerIndex);
    const bbIdx = getNextActiveIndex(room, sbIdx);

    const sbPlayer = room.players[sbIdx];
    const bbPlayer = room.players[bbIdx];

    // Small blind
    const sbAmount = Math.min(room.smallBlind, sbPlayer.chips);
    sbPlayer.chips -= sbAmount;
    sbPlayer.currentBet = sbAmount;
    sbPlayer.totalRoundBet = sbAmount;
    room.pot += sbAmount;
    if (sbPlayer.chips === 0) sbPlayer.allIn = true;

    // Big blind
    const bbAmount = Math.min(room.bigBlind, bbPlayer.chips);
    bbPlayer.chips -= bbAmount;
    bbPlayer.currentBet = bbAmount;
    bbPlayer.totalRoundBet = bbAmount;
    room.pot += bbAmount;
    room.currentBet = bbAmount;
    if (bbPlayer.chips === 0) bbPlayer.allIn = true;

    // First to act is after big blind
    room.currentTurnIndex = getNextActiveIndex(room, bbIdx);

    room.actionLog.push({
        type: 'blinds',
        smallBlind: { name: sbPlayer.name, amount: sbAmount },
        bigBlind: { name: bbPlayer.name, amount: bbAmount },
        dealer: room.players[room.dealerIndex].name,
        timestamp: Date.now()
    });

    return { sbIdx, bbIdx, dealerIdx: room.dealerIndex };
}

function handleAction(room, playerId, action, amount) {
    const playerIdx = room.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1) return { error: 'Player not found' };
    if (playerIdx !== room.currentTurnIndex) return { error: 'Not your turn' };
    if (!room.roundActive) return { error: 'No active round' };

    const player = room.players[playerIdx];
    const toCall = room.currentBet - player.totalRoundBet;

    let logEntry = { type: 'action', player: player.name, action, timestamp: Date.now() };

    switch (action) {
        case 'fold':
            player.folded = true;
            logEntry.detail = 'folded';
            // Check if only one player left
            const remaining = getActivePlayers(room);
            if (remaining.length === 1) {
                // Auto-win
                room.roundStage = 'showdown';
                room.currentTurnIndex = -1;
                room.actionLog.push(logEntry);
                return { autoWin: remaining[0].id, winner: remaining[0].name };
            }
            break;

        case 'check':
            if (toCall > 0) return { error: 'Cannot check, must call or raise' };
            logEntry.detail = 'checked';
            break;

        case 'call':
            if (toCall <= 0) return { error: 'Nothing to call, use check' };
            const callAmount = Math.min(toCall, player.chips);
            player.chips -= callAmount;
            player.currentBet += callAmount;
            player.totalRoundBet += callAmount;
            room.pot += callAmount;
            logEntry.detail = `called ${callAmount}`;
            logEntry.amount = callAmount;
            if (player.chips === 0) {
                player.allIn = true;
                logEntry.detail += ' (all-in)';
            }
            break;

        case 'raise':
            if (!amount || amount < room.minRaise + room.currentBet - player.totalRoundBet) {
                const minTotal = room.minRaise + room.currentBet - player.totalRoundBet;
                return { error: `Minimum raise is ${minTotal} chips` };
            }
            const raiseChips = Math.min(amount, player.chips);
            player.chips -= raiseChips;
            player.currentBet += raiseChips;
            player.totalRoundBet += raiseChips;
            room.pot += raiseChips;
            const raiseOver = player.totalRoundBet - room.currentBet;
            room.minRaise = Math.max(room.minRaise, raiseOver);
            room.currentBet = player.totalRoundBet;
            logEntry.detail = `raised to ${room.currentBet}`;
            logEntry.amount = raiseChips;
            if (player.chips === 0) {
                player.allIn = true;
                logEntry.detail += ' (all-in)';
            }
            break;

        case 'all-in':
            const allInAmount = player.chips;
            player.totalRoundBet += allInAmount;
            player.currentBet += allInAmount;
            room.pot += allInAmount;
            player.chips = 0;
            player.allIn = true;
            if (player.totalRoundBet > room.currentBet) {
                const raise = player.totalRoundBet - room.currentBet;
                room.minRaise = Math.max(room.minRaise, raise);
                room.currentBet = player.totalRoundBet;
                logEntry.detail = `all-in for ${allInAmount} (raise to ${room.currentBet})`;
            } else {
                logEntry.detail = `all-in for ${allInAmount}`;
            }
            logEntry.amount = allInAmount;
            break;

        default:
            return { error: 'Unknown action' };
    }

    room.actionLog.push(logEntry);
    advanceTurn(room);

    return { success: true, logEntry };
}

function endRound(room, winnerIds) {
    if (!room.roundActive) return { error: 'No active round' };

    const share = Math.floor(room.pot / winnerIds.length);
    const winners = [];

    winnerIds.forEach(id => {
        const p = room.players.find(pl => pl.id === id);
        if (p) {
            p.chips += share;
            winners.push({ name: p.name, amount: share });
        }
    });

    // Handle remainder
    const remainder = room.pot - (share * winnerIds.length);
    if (remainder > 0) {
        const firstWinner = room.players.find(p => p.id === winnerIds[0]);
        if (firstWinner) firstWinner.chips += remainder;
    }

    // Mark eliminated players
    room.players.forEach(p => {
        if (p.chips <= 0 && !p.eliminated) {
            p.eliminated = true;
            p.chips = 0;
        }
    });

    room.pot = 0;
    room.roundActive = false;
    room.roundStage = null;
    room.currentTurnIndex = -1;

    room.actionLog.push({
        type: 'round-end',
        winners,
        timestamp: Date.now()
    });

    return { winners };
}

function getRoomState(room, forPlayerId) {
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
    };
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

        callback({ success: true, roomCode: room.code });
        io.to(room.code).emit('room-update', getRoomState(room, socket.id));
    });

    socket.on('join-room', (data, callback) => {
        const code = (data.code || '').trim().toUpperCase();
        const name = (data.name || '').trim();

        if (!code || !name) return callback({ error: 'Room code and name are required' });

        const room = rooms[code];
        if (!room) return callback({ error: 'Room not found' });
        if (room.roundActive) return callback({ error: 'Cannot join during an active round' });

        const result = addPlayer(code, socket.id, name);
        if (result === 'NAME_TAKEN') return callback({ error: 'That name is already taken' });
        if (!result) return callback({ error: 'Failed to join room' });

        currentRoom = code;
        playerName = name;
        socket.join(code);

        callback({ success: true, roomCode: code });

        // Send personalized state to each player
        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        io.to(code).emit('toast', { message: `${name} joined the table`, type: 'info' });
    });

    socket.on('start-round', (callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        if (socket.id !== room.hostId) return callback({ error: 'Only the host can start a round' });
        if (room.roundActive) return callback({ error: 'Round already active' });

        const result = startRound(room);
        if (!result) return callback({ error: 'Need at least 2 players' });

        callback({ success: true });

        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        const dealer = room.players[result.dealerIdx].name;
        io.to(currentRoom).emit('toast', { message: `New hand! Dealer: ${dealer}`, type: 'deal' });
    });

    socket.on('player-action', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });

        const result = handleAction(room, socket.id, data.action, data.amount);
        if (result.error) return callback({ error: result.error });

        callback({ success: true });

        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        if (result.logEntry) {
            io.to(currentRoom).emit('toast', {
                message: `${result.logEntry.player} ${result.logEntry.detail}`,
                type: data.action
            });
        }

        if (result.autoWin) {
            io.to(currentRoom).emit('toast', {
                message: `${result.winner} wins the pot!`,
                type: 'win'
            });
        }
    });

    socket.on('end-round', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        if (socket.id !== room.hostId) return callback({ error: 'Only the host can end the round' });

        const winnerIds = data.winnerIds || [];
        if (winnerIds.length === 0) return callback({ error: 'Select at least one winner' });

        const result = endRound(room, winnerIds);
        if (result.error) return callback({ error: result.error });

        callback({ success: true });

        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        const winnerNames = result.winners.map(w => `${w.name} (+${w.amount})`).join(', ');
        io.to(currentRoom).emit('toast', {
            message: `🏆 ${winnerNames}`,
            type: 'win'
        });
    });

    socket.on('reset-game', (callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        if (socket.id !== room.hostId) return callback({ error: 'Only the host can reset' });

        room.players.forEach(p => {
            p.chips = room.startingChips;
            p.folded = false;
            p.allIn = false;
            p.eliminated = false;
            p.currentBet = 0;
            p.totalRoundBet = 0;
        });
        room.pot = 0;
        room.currentBet = 0;
        room.roundActive = false;
        room.roundStage = null;
        room.currentTurnIndex = -1;
        room.dealerIndex = 0;
        room.actionLog = [];

        callback({ success: true });

        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        io.to(currentRoom).emit('toast', { message: 'Game reset! All chips restored.', type: 'info' });
    });

    socket.on('kick-player', (data, callback) => {
        if (!currentRoom) return callback({ error: 'Not in a room' });
        const room = rooms[currentRoom];
        if (!room) return callback({ error: 'Room not found' });
        if (socket.id !== room.hostId) return callback({ error: 'Only the host can kick players' });

        const targetIdx = room.players.findIndex(p => p.id === data.playerId);
        if (targetIdx === -1) return callback({ error: 'Player not found' });

        const kicked = room.players[targetIdx];
        io.to(kicked.id).emit('kicked');
        room.players.splice(targetIdx, 1);

        callback({ success: true });

        room.players.forEach(p => {
            io.to(p.id).emit('room-update', getRoomState(room, p.id));
        });

        io.to(currentRoom).emit('toast', { message: `${kicked.name} was removed from the table`, type: 'info' });
    });

    socket.on('disconnect', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.connected = false;

            room.players.forEach(p => {
                if (p.connected) {
                    io.to(p.id).emit('room-update', getRoomState(room, p.id));
                }
            });

            io.to(currentRoom).emit('toast', { message: `${player.name} disconnected`, type: 'warning' });
        }

        // Clean up empty rooms
        const connected = room.players.filter(p => p.connected);
        if (connected.length === 0) {
            delete rooms[currentRoom];
        }
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
