/* ═══════════════════════════════════════════════════════════════
   POKLER — Client Application
   Socket.io client for real-time poker room interactions
   ═══════════════════════════════════════════════════════════════ */

const socket = io();

// ─── State ─────────────────────────────────────────────────────
let gameState = null;
let myId = null;
let isHost = false;
let raiseMode = false;
let lastStateVersion = 0;
let pendingAction = false;
let resumeInProgress = false;

const SESSION_KEY = 'pokler-session';

// ─── DOM Elements ──────────────────────────────────────────────
const lobbyView = document.getElementById('lobby-view');
const gameView = document.getElementById('game-view');

// Lobby
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const lobbyError = document.getElementById('lobby-error');

// Game Top Bar
const roomCodeDisplay = document.getElementById('room-code-display');
const roundStageDisplay = document.getElementById('round-stage-display');
const handIdDisplay = document.getElementById('hand-id-display');
const connectionStatus = document.getElementById('connection-status');

// Pot
const potAmountEl = document.getElementById('pot-amount');

// Board & Cards
const boardCards = document.getElementById('board-cards');
const holeCards = document.getElementById('hole-cards');

// Players
const playersSection = document.getElementById('players-section');

// Your Status
const yourChipCount = document.getElementById('your-chip-count');
const yourCurrentBet = document.getElementById('your-current-bet');

// Action Panel
const actionPanel = document.getElementById('action-panel');
const actionButtons = document.getElementById('action-buttons');
const btnCheck = document.getElementById('btn-check');
const btnCall = document.getElementById('btn-call');
const callAmountEl = document.getElementById('call-amount');
const btnRaise = document.getElementById('btn-raise');
const btnAllin = document.getElementById('btn-allin');
const btnFold = document.getElementById('btn-fold');
const waitingMsg = document.getElementById('waiting-msg');
const waitingText = document.getElementById('waiting-text');

// Raise Panel
const raisePanel = document.getElementById('raise-panel');
const raiseSlider = document.getElementById('raise-slider');
const raiseValue = document.getElementById('raise-value');
const raisePresets = document.getElementById('raise-presets');
const raiseCancel = document.getElementById('raise-cancel');
const raiseConfirm = document.getElementById('raise-confirm');

// Host Controls
const hostControls = document.getElementById('host-controls');
const btnStartRound = document.getElementById('btn-start-round');

// Menu
const btnMenu = document.getElementById('btn-menu');
const menuOverlay = document.getElementById('menu-overlay');
const btnCloseMenu = document.getElementById('btn-close-menu');
const menuRoomCode = document.getElementById('menu-room-code');
const menuBlinds = document.getElementById('menu-blinds');
const actionLogEl = document.getElementById('action-log');
const hostMenuSection = document.getElementById('host-menu-section');
const btnResetGame = document.getElementById('btn-reset-game');
const btnLeave = document.getElementById('btn-leave');

// Toast
const toastContainer = document.getElementById('toast-container');

// ─── Lobby Events ──────────────────────────────────────────────
btnCreate.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    if (!name) return showLobbyError('Please enter your name');

    btnCreate.disabled = true;
    socket.emit('create-room', { name }, (res) => {
        btnCreate.disabled = false;
        if (res.error) return showLobbyError(res.error);
        myId = socket.id;
        isHost = true;
        saveSession({ code: res.roomCode, token: res.token, name });
        switchToGame();
    });
});

btnJoin.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!name) return showLobbyError('Please enter your name');
    if (!code || code.length < 4) return showLobbyError('Enter a 4-character room code');

    btnJoin.disabled = true;
    socket.emit('join-room', { name, code }, (res) => {
        btnJoin.disabled = false;
        if (res.error) return showLobbyError(res.error);
        myId = socket.id;
        isHost = false;
        saveSession({ code: res.roomCode, token: res.token, name });
        switchToGame();
    });
});

// Enter key on inputs
playerNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnCreate.click();
});

roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
});

roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase();
});

function showLobbyError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.remove('hidden');
    setTimeout(() => lobbyError.classList.add('hidden'), 4000);
}

function switchToGame() {
    lobbyView.classList.remove('active');
    gameView.classList.add('active');
}

function saveSession({ code, token, name }) {
    if (!code || !token || !name) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, name }));
}

function loadSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function clearSession() {
    localStorage.removeItem(SESSION_KEY);
}

function updateConnectionStatus(connected) {
    if (!connectionStatus) return;
    if (connected) {
        connectionStatus.textContent = 'Connected';
        connectionStatus.classList.remove('disconnected');
        connectionStatus.classList.add('connected');
    } else {
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.classList.remove('connected');
        connectionStatus.classList.add('disconnected');
    }
}

function attemptResume() {
    if (resumeInProgress) return;
    const session = loadSession();
    if (!session) return;
    resumeInProgress = true;
    socket.emit('resume-session', session, (res) => {
        resumeInProgress = false;
        if (res && res.success) {
            myId = socket.id;
            isHost = !!res.isHost;
            switchToGame();
            showToast('Session restored', 'info');
            return;
        }
        clearSession();
    });
}

// ─── Socket Events ─────────────────────────────────────────────
socket.on('room-update', (state) => {
    if (state.stateVersion !== undefined && state.stateVersion <= lastStateVersion) return;
    lastStateVersion = state.stateVersion || (lastStateVersion + 1);
    gameState = state;
    myId = socket.id;
    isHost = state.hostId === myId;
    pendingAction = false;
    raiseMode = false;
    renderGame();
});

socket.on('toast', (data) => {
    showToast(data.message, data.type);
});

socket.on('kicked', () => {
    alert('You have been removed from the room.');
    clearSession();
    location.reload();
});

socket.on('disconnect', () => {
    showToast('Disconnected from server. Reconnecting...', 'warning');
    updateConnectionStatus(false);
    pendingAction = false;
});

socket.on('connect', () => {
    updateConnectionStatus(true);
    attemptResume();
    if (gameState) {
        showToast('Reconnected!', 'info');
    }
});

// ─── Render Functions ──────────────────────────────────────────
function renderGame() {
    if (!gameState) return;

    // Top bar
    roomCodeDisplay.textContent = gameState.code;
    const stageText = gameState.roundStage || 'Waiting';
    roundStageDisplay.textContent = stageText.replace('-', ' ').toUpperCase();
    roundStageDisplay.setAttribute('data-stage', String(gameState.roundStage));
    if (handIdDisplay) {
        handIdDisplay.textContent = `Hand #${gameState.handId || 0}`;
    }

    // Pot
    const prevPot = potAmountEl.textContent;
    potAmountEl.textContent = gameState.pot;
    if (prevPot !== String(gameState.pot)) {
        potAmountEl.classList.add('updated');
        setTimeout(() => potAmountEl.classList.remove('updated'), 500);
    }

    // Players
    renderPlayers();

    // Cards
    renderBoard();
    renderHoleCards();

    // My status
    const me = gameState.players.find(p => p.isYou);
    if (me) {
        yourChipCount.textContent = me.chips;
        yourCurrentBet.textContent = me.currentBet;
    }

    // Actions
    renderActions();

    // Host controls
    renderHostControls();

    // Menu info
    menuRoomCode.textContent = gameState.code;
    menuBlinds.textContent = `${gameState.smallBlind} / ${gameState.bigBlind}`;
    renderActionLog();

    if (isHost) {
        hostMenuSection.classList.remove('hidden');
    } else {
        hostMenuSection.classList.add('hidden');
    }
}

function renderPlayers() {
    const players = gameState.players;
    playersSection.innerHTML = '';

    players.forEach((p, idx) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        if (p.isYou) card.classList.add('is-you');
        if (idx === gameState.currentTurnIndex) card.classList.add('is-turn');
        if (p.folded) card.classList.add('folded');
        if (p.eliminated) card.classList.add('eliminated');
        if (!p.connected) card.classList.add('disconnected');

        const avatarColor = `avatar-${idx % 8}`;
        const initial = p.name.charAt(0).toUpperCase();

        let roleHTML = '';
        if (gameState.roundActive || gameState.roundStage === 'showdown') {
            if (idx === gameState.dealerIndex) {
                roleHTML = '<span class="player-role role-dealer">D</span>';
            }
        }
        if (p.id === gameState.hostId) {
            roleHTML += '<span class="player-role role-host">HOST</span>';
        }

        let statusHTML = '';
        if (p.eliminated) {
            statusHTML = '<span class="player-status status-eliminated">Out</span>';
        } else if (!p.connected) {
            statusHTML = '<span class="player-status status-disconnected">Away</span>';
        } else if (p.allIn) {
            statusHTML = '<span class="player-status status-allin">All-In</span>';
        } else if (p.folded && gameState.roundActive) {
            statusHTML = '<span class="player-status status-folded">Folded</span>';
        }

        const betDisplay = (gameState.roundActive || gameState.roundStage === 'showdown') && p.currentBet > 0
            ? `<span class="player-bet">${p.currentBet}</span>`
            : '';

        card.innerHTML = `
      <div class="player-avatar ${avatarColor}">${initial}</div>
      <div class="player-info">
        <div class="player-name">${p.name}${p.isYou ? ' (You)' : ''}</div>
        <div class="player-meta">
          <span class="player-chips">🪙 ${p.chips}</span>
          ${statusHTML}
        </div>
      </div>
      ${betDisplay}
      ${roleHTML}
    `;

    playersSection.appendChild(card);
    });
}

function formatCard(card) {
    const suitSymbols = {
        S: '♠',
        H: '♥',
        D: '♦',
        C: '♣',
    };
    if (!card) return { label: '', suitClass: '' };
    const suitSymbol = suitSymbols[card.suit] || card.suit;
    const suitClass = card.suit ? `card-suit-${card.suit.toLowerCase()}` : '';
    return { label: `${card.rank}${suitSymbol}`, suitClass };
}

function renderBoard() {
    if (!boardCards || !gameState) return;
    boardCards.innerHTML = '';
    const cards = gameState.board || [];
    for (let i = 0; i < 5; i++) {
        const cardEl = document.createElement('div');
        cardEl.className = 'table-card';
        if (cards[i]) {
            const formatted = formatCard(cards[i]);
            cardEl.textContent = formatted.label;
            if (formatted.suitClass) cardEl.classList.add(formatted.suitClass);
        } else {
            cardEl.classList.add('table-card-empty');
        }
        boardCards.appendChild(cardEl);
    }
}

function renderHoleCards() {
    if (!holeCards || !gameState) return;
    holeCards.innerHTML = '';
    const me = gameState.players.find(p => p.isYou);
    const cards = me ? me.holeCards || [] : [];
    for (let i = 0; i < 2; i++) {
        const cardEl = document.createElement('div');
        cardEl.className = 'table-card table-card-hole';
        if (cards[i]) {
            const formatted = formatCard(cards[i]);
            cardEl.textContent = formatted.label;
            if (formatted.suitClass) cardEl.classList.add(formatted.suitClass);
        } else {
            cardEl.classList.add('table-card-empty');
        }
        holeCards.appendChild(cardEl);
    }
}

function renderActions() {
    const me = gameState.players.find(p => p.isYou);
    if (!me) return;

    const myIdx = gameState.players.findIndex(p => p.isYou);
    const isMyTurn = myIdx === gameState.currentTurnIndex;
    const roundOn = gameState.roundActive;
    const showdown = gameState.roundStage === 'showdown';

    if (pendingAction) {
        actionButtons.classList.add('hidden');
        raisePanel.classList.add('hidden');
        waitingMsg.classList.add('active');
        waitingText.textContent = 'Waiting for server...';
        return;
    }

    if (!roundOn || me.folded || me.eliminated || me.allIn) {
        actionButtons.classList.add('hidden');
        raisePanel.classList.add('hidden');
        waitingMsg.classList.add('active');

        if (!roundOn && showdown) {
            waitingText.textContent = 'Showdown complete — review results';
        } else if (!roundOn) {
            waitingText.textContent = isHost ? 'Deal a new hand to start' : 'Waiting for host to deal...';
        } else if (me.folded) {
            waitingText.textContent = 'You folded this hand';
        } else if (me.allIn) {
            waitingText.textContent = 'You\'re all in! Waiting for results...';
        } else if (me.eliminated) {
            waitingText.textContent = 'You\'re out of chips';
        }
        return;
    }

    if (!isMyTurn) {
        actionButtons.classList.add('hidden');
        raisePanel.classList.add('hidden');
        waitingMsg.classList.add('active');
        const currentPlayer = gameState.players[gameState.currentTurnIndex];
        waitingText.textContent = currentPlayer
            ? `Waiting for ${currentPlayer.name}...`
            : 'Waiting...';
        return;
    }

    // It's my turn!
    waitingMsg.classList.remove('active');

    if (raiseMode) {
        actionButtons.classList.add('hidden');
        raisePanel.classList.remove('hidden');
        return;
    }

    actionButtons.classList.remove('hidden');
    raisePanel.classList.add('hidden');

    const toCall = gameState.currentBet - me.currentBet;

    // Check vs Call
    if (toCall > 0) {
        btnCheck.classList.add('hidden');
        btnCall.classList.remove('hidden');
        callAmountEl.textContent = Math.min(toCall, me.chips);
    } else {
        btnCheck.classList.remove('hidden');
        btnCall.classList.add('hidden');
    }

    // Raise
    const minRaiseAmount = gameState.minRaise + gameState.currentBet - me.currentBet;
    btnRaise.disabled = me.chips <= toCall || me.chips < minRaiseAmount;

    // All-in
    btnAllin.disabled = false;

    // Fold
    btnFold.disabled = false;

    // Vibrate on turn
    if (navigator.vibrate) navigator.vibrate(100);
}

function renderHostControls() {
    if (!isHost) {
        hostControls.classList.add('hidden');
        return;
    }

    hostControls.classList.remove('hidden');

    const roundActive = gameState.roundActive;
    if (!roundActive) {
        btnStartRound.classList.remove('hidden');
        const eligible = gameState.players.filter(p => !p.eliminated).length;
        btnStartRound.disabled = eligible < 2;
    } else {
        btnStartRound.classList.add('hidden');
    }
}

function renderActionLog() {
    if (!gameState || !gameState.actionLog) return;

    actionLogEl.innerHTML = '';
    gameState.actionLog.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'log-entry';

        if (entry.type === 'action') {
            div.classList.add('log-entry-action');
            div.textContent = `${entry.player} ${entry.detail}`;
        } else if (entry.type === 'stage') {
            div.classList.add('log-entry-stage');
            div.textContent = `─── ${entry.stage.toUpperCase()} ───`;
        } else if (entry.type === 'blinds') {
            div.textContent = `Dealer: ${entry.dealer} | SB: ${entry.smallBlind.name} (${entry.smallBlind.amount}) | BB: ${entry.bigBlind.name} (${entry.bigBlind.amount})`;
        } else if (entry.type === 'round-end') {
            div.classList.add('log-entry-win');
            const winners = entry.winners.map(w => {
                const handText = w.hand ? ` (${w.hand})` : '';
                return `${w.name} +${w.amount}${handText}`;
            }).join(', ');
            div.textContent = `🏆 ${winners}`;
        }

        actionLogEl.appendChild(div);
    });

    actionLogEl.scrollTop = actionLogEl.scrollHeight;
}

// ─── Action Handlers ───────────────────────────────────────────
function doAction(action, amount) {
    if (pendingAction) return;
    pendingAction = true;
    renderActions();
    socket.emit('player-action', { action, amount }, (res) => {
        if (res.error) {
            pendingAction = false;
            showToast(res.error, 'warning');
            renderActions();
        }
        raiseMode = false;
    });
}

btnCheck.addEventListener('click', () => doAction('check'));
btnCall.addEventListener('click', () => doAction('call'));
btnFold.addEventListener('click', () => doAction('fold'));
btnAllin.addEventListener('click', () => doAction('all-in'));

btnRaise.addEventListener('click', () => {
    raiseMode = true;
    const me = gameState.players.find(p => p.isYou);
    if (!me) return;

    const toCall = gameState.currentBet - me.currentBet;
    const minRaise = gameState.minRaise + toCall;
    const maxRaise = me.chips;

    if (minRaise > maxRaise) {
        showToast('Not enough chips to raise', 'warning');
        raiseMode = false;
        renderActions();
        return;
    }

    raiseSlider.min = minRaise;
    raiseSlider.max = maxRaise;
    raiseSlider.value = minRaise;
    raiseValue.textContent = minRaise;

    renderActions();
});

raiseSlider.addEventListener('input', () => {
    raiseValue.textContent = raiseSlider.value;
});

raiseCancel.addEventListener('click', () => {
    raiseMode = false;
    renderActions();
});

raiseConfirm.addEventListener('click', () => {
    const amount = parseInt(raiseSlider.value);
    doAction('raise', amount);
});

// Raise presets
raisePresets.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-preset');
    if (!btn) return;

    const multiply = parseFloat(btn.dataset.multiply);
    const me = gameState.players.find(p => p.isYou);
    if (!me) return;

    let value;
    if (multiply === 0.5) {
        value = Math.floor(gameState.pot / 2);
    } else if (multiply === 1) {
        value = gameState.pot;
    } else {
        value = Math.floor(gameState.currentBet * multiply);
    }

    const toCall = gameState.currentBet - me.currentBet;
    const minRaise = gameState.minRaise + toCall;
    value = Math.max(value, minRaise);
    value = Math.min(value, me.chips);

    raiseSlider.value = value;
    raiseValue.textContent = value;
});

// Host controls
btnStartRound.addEventListener('click', () => {
    btnStartRound.disabled = true;
    socket.emit('start-round', (res) => {
        btnStartRound.disabled = false;
        if (res.error) showToast(res.error, 'warning');
    });
});

// Menu
btnMenu.addEventListener('click', () => {
    menuOverlay.classList.remove('hidden');
});

btnCloseMenu.addEventListener('click', () => {
    menuOverlay.classList.add('hidden');
});

menuOverlay.addEventListener('click', (e) => {
    if (e.target === menuOverlay) menuOverlay.classList.add('hidden');
});

btnResetGame.addEventListener('click', () => {
    if (confirm('Reset the game? All chips will be restored to starting amount.')) {
        socket.emit('reset-game', (res) => {
            if (res.error) showToast(res.error, 'warning');
            menuOverlay.classList.add('hidden');
        });
    }
});

btnLeave.addEventListener('click', () => {
    if (confirm('Leave the room?')) {
        clearSession();
        location.reload();
    }
});

// ─── Toast System ──────────────────────────────────────────────
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 3000);
}

// ─── Focus name input on load ──────────────────────────────────
playerNameInput.focus();
