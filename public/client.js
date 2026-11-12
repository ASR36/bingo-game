const socket = io({ reconnectionDelayMax: 4000 });

/* ---------------- Session (survives refresh) ---------------- */
const SESSION_KEY = 'bingo.session';
const NAME_KEY = 'bingo.name';
const safeStore = {
  get(store, key) {
    try { return store.getItem(key); } catch { return null; }
  },
  set(store, key, value) {
    try { store.setItem(key, value); } catch { /* private mode */ }
  },
  remove(store, key) {
    try { store.removeItem(key); } catch { /* private mode */ }
  },
};
function readSession() {
  try { return JSON.parse(safeStore.get(sessionStorage, SESSION_KEY) || 'null'); } catch { return null; }
}
// One stable id per browser tab, so refreshing the tab keeps your seat.
function clientId() {
  const saved = readSession();
  if (saved?.clientId) return saved.clientId;
  if (!window.__bingoClientId) {
    const raw = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    window.__bingoClientId = raw.replace(/[^A-Za-z0-9_-]/g, '');
  }
  return window.__bingoClientId;
}
function saveSession(code) {
  safeStore.set(sessionStorage, SESSION_KEY, JSON.stringify({ code, clientId: clientId() }));
  history.replaceState(null, '', `?room=${code}`);
}
function clearSession() {
  safeStore.remove(sessionStorage, SESSION_KEY);
  history.replaceState(null, '', location.pathname);
}

const elements = {
  name: document.getElementById('player-name'),
  roomCode: document.getElementById('room-code'),
  status: document.getElementById('status'),
  players: document.getElementById('players'),
  calledNumbers: document.getElementById('called-numbers'),
  selectedNumbers: document.getElementById('selected-numbers'),
  winners: document.getElementById('winners'),
  card: document.getElementById('bingo-card'),
  infoCode: document.getElementById('info-code'),
  infoStatus: document.getElementById('info-status'),
  infoHost: document.getElementById('info-host'),
  infoBoardSize: document.getElementById('info-board-size'),
  turnIndicator: document.getElementById('turn-indicator'),
  loserSection: document.getElementById('loser-section'),
  loserName: document.getElementById('loser-name'),
  createRoom: document.getElementById('create-room'),
  joinRoom: document.getElementById('join-room'),
  startGame: document.getElementById('start-game'),
  resetAfterGame: document.getElementById('reset-after-game'),
  boardSizeSelect: document.getElementById('board-size'),
  chatPanel: document.getElementById('chat-panel'),
  chatMessages: document.getElementById('chat-messages'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
  chatToggle: document.getElementById('chat-toggle'),
  chatClose: document.getElementById('chat-close'),
  chatBadge: document.getElementById('chat-badge'),
  chatBackdrop: document.getElementById('chat-backdrop'),
  chatTyping: document.getElementById('chat-typing'),
  leaveRoom: document.getElementById('leave-room'),
  topCode: document.getElementById('top-code'),
  copyInvite: document.getElementById('copy-invite'),
  arenaLink: document.getElementById('arena-link'),
  toast: document.getElementById('toast'),
  side: document.querySelector('.side'),
  playersCount: document.getElementById('players-count'),
  calledCount: document.getElementById('called-count'),
};

/* ---------------- Boot ---------------- */
if (window.APP_CONFIG?.arenaUrl) {
  elements.arenaLink.href = window.APP_CONFIG.arenaUrl;
  elements.arenaLink.hidden = false;
}
elements.name.value = safeStore.get(localStorage, NAME_KEY) || '';
{
  const params = new URLSearchParams(location.search);
  if (params.get('room')) elements.roomCode.value = params.get('room').toUpperCase().slice(0, 6);
}
elements.side.dataset.active = 'leaderboard';
document.querySelectorAll('.pane-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    elements.side.dataset.active = tab.dataset.pane;
    document.querySelectorAll('.pane-tab').forEach((t) => {
      t.classList.toggle('is-active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
  })
);
elements.roomCode.addEventListener('input', () => {
  elements.roomCode.value = elements.roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
elements.roomCode.addEventListener('keydown', (e) => e.key === 'Enter' && elements.joinRoom.click());
elements.name.addEventListener('keydown', (e) => e.key === 'Enter' && (elements.roomCode.value ? elements.joinRoom : elements.createRoom).click());

elements.leaveRoom.addEventListener('click', () => {
  if (!confirm('Leave this room?')) return;
  socket.emit('leaveRoom', {}, () => {});
  clearSession();
  window.location.reload();
});

elements.copyInvite.addEventListener('click', async () => {
  if (!state.room) return;
  const url = `${location.origin}${location.pathname}?room=${state.room.code}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: 'Join my Bingo room', url });
    } else {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    }
  } catch {
    /* share sheet dismissed */
  }
});

let toastTimer = null;
function toast(text, isError = false) {
  if (!text) return;
  elements.toast.textContent = text;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2800);
}

const state = {
  playerId: null,
  room: null,
  card: [],
  marked: new Set(),
  completedCells: new Map(),
  boardSize: 5,
  chat: [],
  chatOpen: false,
  unread: 0,
};

const chatDrawerQuery = window.matchMedia('(max-width: 1199px)');

const winPatternCache = new Map();

function rememberName() {
  const name = elements.name.value.trim();
  if (name) safeStore.set(localStorage, NAME_KEY, name);
  return name;
}

elements.createRoom.addEventListener('click', () => {
  if (!rememberName()) return setStatus('Enter a display name first.', true);
  socket.emit('createRoom', { name: elements.name.value, clientId: clientId() }, handleAck);
});

const soloChoice = { bots: '1', level: 'medium' };
document.querySelectorAll('.segmented[data-group]').forEach((group) => {
  group.addEventListener('click', (e) => {
    const opt = e.target.closest('.segmented__opt');
    if (!opt) return;
    soloChoice[group.dataset.group] = opt.dataset.value;
    group.querySelectorAll('.segmented__opt').forEach((o) => {
      o.classList.toggle('is-active', o === opt);
      o.setAttribute('aria-checked', String(o === opt));
    });
  });
});

document.getElementById('play-computer').addEventListener('click', () => {
  if (!rememberName()) return setStatus('Enter a display name first.', true);
  socket.emit(
    'playComputer',
    {
      name: elements.name.value,
      clientId: clientId(),
      bots: Number(soloChoice.bots),
      difficulty: soloChoice.level,
      boardSize: Number(elements.boardSizeSelect?.value) || 5,
    },
    handleAck
  );
});

elements.joinRoom.addEventListener('click', () => {
  if (!rememberName()) return setStatus('Enter a display name first.', true);
  if (!elements.roomCode.value.trim()) return setStatus('Enter the room code.', true);
  socket.emit(
    'joinRoom',
    { name: elements.name.value, roomCode: elements.roomCode.value, clientId: clientId() },
    handleAck
  );
});

elements.startGame.addEventListener('click', () => {
  if (!state.room) return;
  socket.emit('startGame', { roomCode: state.room.code }, handleAck);
});

elements.resetAfterGame.addEventListener('click', () => {
  if (!state.room) return;
  socket.emit('resetGame', { roomCode: state.room.code }, handleAck);
});

elements.boardSizeSelect.addEventListener('change', () => {
  if (!state.room) return;
  const size = parseInt(elements.boardSizeSelect.value, 10);
  socket.emit('changeBoardSize', { roomCode: state.room.code, size }, handleAck);
});



socket.on('player:card', (card) => {
  state.card = card;
  const inferredSize = Math.round(Math.sqrt(card.length)) || state.boardSize || 5;
  state.boardSize = inferredSize;
  state.marked = new Set();
  state.completedCells = new Map();
  renderCard();
});

socket.on('number:called', (number) => {
  // Update local state immediately so sync works
  if (state.room && state.room.calledNumbers) {
    if (!state.room.calledNumbers.includes(number)) {
      state.room.calledNumbers.push(number);
    }
  }

  // Number is called - automatically mark it if it's on our card
  if (state.card.includes(number)) {
    state.marked.add(number);
    state.completedCells = computeCompletedCells();
    syncMarkedNumbersToServer();
  }
  renderCard();
  renderCalledNumbers();
});

socket.on('room:update', (room) => {
  state.room = room;

  // Sync marked numbers from server
  const myPlayer = room.players.find((p) => p.id === state.playerId);
  if (myPlayer && Array.isArray(myPlayer.marked)) {
    state.marked = new Set(myPlayer.marked);
  }

  state.boardSize = room.boardSize ?? state.boardSize ?? 5;
  if (elements.boardSizeSelect) {
    elements.boardSizeSelect.value = String(state.boardSize);
    const isHost = room.hostId === state.playerId;
    const canChangeSize = isHost && room.status === 'waiting';
    elements.boardSizeSelect.disabled = !canChangeSize;
  }

  renderInfo();
  renderPlayers();
  renderCalledNumbers();
  renderWinners();
  state.completedCells = computeCompletedCells();
  renderCard();
  updateControls();
  updateChatControls();

  // Auto-check if current player completed a line
  if (room.status === 'running' && room.currentPlayerId === state.playerId) {
    const player = room.players.find(p => p.id === state.playerId);
    if (!player?.isEliminated && state.completedCells.size > 0) {
      const hasLine = Array.from(state.completedCells.values()).some(stripes => stripes.size > 0);
      if (hasLine) {
        // Player completed a line - can declare bingo
        // Player completed a line - auto-scored by server
      }
    }
  }
});

socket.on('room:bingo', ({ player, points }) => {
  setStatus(`${player} completed a line! Points: ${points}/5`, false);
});

socket.on('room:pointsEarned', ({ player, points, linesCompleted }) => {
  setStatus(`${player} earned ${linesCompleted} point(s)! Total: ${points}/5`, false);
});

socket.on('room:gameEnded', ({ loser, draw, winners: winnerList }) => {
  if (draw) {
    const names = (winnerList || []).map((w) => w.name).join(' & ');
    setStatus(`It's a draw — ${names} finished on the same call.`, false);
  } else if (loser) {
    setStatus(`Game over. ${loser} is last standing.`, false);
  } else {
    setStatus('Game over.', false);
  }
});

socket.on('room:playerWon', ({ player, rank, tie }) => {
  setStatus(tie ? `${player} finished together — shared #${rank}!` : `${player} finished #${rank}!`, false);
});

socket.on('room:hostChanged', (name) => {
  setStatus(`${name} is now the host.`, false);
});

socket.on('connect_error', () => {
  setStatus('Unable to reach server. Make sure it is running.', true);
});

socket.on('player:kicked', (reason) => {
  clearSession();
  alert(reason || 'You were removed from the room by the host.');
  window.location.reload();
});

socket.on('player:replaced', () => {
  alert('This game was opened in another tab.');
  clearSession();
  window.location.reload();
});

/* ---------------- Chat ---------------- */

socket.on('chat:history', (messages) => {
  state.chat = Array.isArray(messages) ? messages.slice() : [];
  renderChat();
});

/* ----- Typing indicator ----- */
const TYPING_IDLE_MS = 3000;     // stop "typing" after this long without keystrokes
const TYPING_RESEND_MS = 2000;   // re-announce at most this often while typing
const TYPING_EXPIRE_MS = 5000;   // drop a remote typer if we stop hearing from them
const typingUsers = new Map();   // playerId -> { name, timer }
let typingSelf = { active: false, lastSent: 0, idleTimer: null };

socket.on('chat:typing', ({ playerId, name, typing } = {}) => {
  if (!playerId || playerId === state.playerId) return;
  clearTimeout(typingUsers.get(playerId)?.timer);
  if (typing) {
    const timer = setTimeout(() => {
      typingUsers.delete(playerId);
      renderTyping();
    }, TYPING_EXPIRE_MS);
    typingUsers.set(playerId, { name, timer });
  } else {
    typingUsers.delete(playerId);
  }
  renderTyping();
});

function emitTyping(typing) {
  if (!state.room || !socket.connected) return;
  socket.emit('chat:typing', { roomCode: state.room.code, typing });
}

function stopTyping() {
  clearTimeout(typingSelf.idleTimer);
  if (typingSelf.active) emitTyping(false);
  typingSelf = { active: false, lastSent: 0, idleTimer: null };
}

elements.chatInput.addEventListener('input', () => {
  if (!elements.chatInput.value.trim()) {
    stopTyping();
    return;
  }
  const now = Date.now();
  if (!typingSelf.active || now - typingSelf.lastSent > TYPING_RESEND_MS) {
    emitTyping(true);
    typingSelf.active = true;
    typingSelf.lastSent = now;
  }
  clearTimeout(typingSelf.idleTimer);
  typingSelf.idleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
});

elements.chatInput.addEventListener('blur', stopTyping);

function renderTyping() {
  const names = Array.from(typingUsers.values()).map((u) => u.name).filter(Boolean);
  const el = elements.chatTyping;
  el.textContent = '';
  if (!names.length) {
    el.classList.remove('is-active');
    return;
  }
  let label;
  if (names.length === 1) label = `${names[0]} is typing`;
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
  else label = `${names.length} people are typing`;

  const dots = document.createElement('span');
  dots.className = 'chat__typing-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
  const text = document.createElement('span');
  text.textContent = label;
  el.append(dots, text);
  el.classList.add('is-active');
}

socket.on('chat:message', (message) => {
  if (!message || state.chat.some((m) => m.id === message.id)) return;
  if (message.playerId && typingUsers.has(message.playerId)) {
    clearTimeout(typingUsers.get(message.playerId).timer);
    typingUsers.delete(message.playerId);
    renderTyping();
  }
  state.chat.push(message);
  if (state.chat.length > 100) state.chat.shift();
  appendChatMessage(message);

  const fromMe = message.playerId && message.playerId === state.playerId;
  if (!fromMe && message.type === 'user' && !isChatVisible()) {
    state.unread += 1;
    updateChatBadge();
  }
});

socket.on('disconnect', () => {
  updateChatControls();
  if (state.room) toast('Connection lost — reconnecting…', true);
});

socket.on('connect', () => {
  updateChatControls();
  // Rejoin the same seat after a refresh or a dropped connection.
  const saved = readSession();
  if (!saved) return;
  socket.emit('resumeRoom', { roomCode: saved.code, clientId: saved.clientId }, (response) => {
    if (response?.ok) {
      handleAck(response);
    } else {
      clearSession();
      if (state.room) {
        alert('Your seat in the room has expired.');
        window.location.reload();
      }
    }
  });
});

elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || !state.room) return;

  elements.chatSend.disabled = true;
  clearTimeout(typingSelf.idleTimer);
  typingSelf = { active: false, lastSent: 0, idleTimer: null }; // server clears it on send
  socket.emit('chat:send', { roomCode: state.room.code, text }, (response) => {
    updateChatControls();
    if (response?.ok) {
      elements.chatInput.value = '';
      elements.chatInput.focus();
    } else {
      setStatus(response?.message ?? 'Unable to send message.', true);
    }
  });
});

elements.chatToggle.addEventListener('click', () => setChatOpen(!state.chatOpen));
elements.chatClose.addEventListener('click', () => setChatOpen(false));
elements.chatBackdrop.addEventListener('click', () => setChatOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.chatOpen) setChatOpen(false);
});
chatDrawerQuery.addEventListener('change', () => {
  if (!chatDrawerQuery.matches) setChatOpen(false);
  if (isChatVisible()) {
    state.unread = 0;
    updateChatBadge();
  }
});

function isChatVisible() {
  return !chatDrawerQuery.matches || state.chatOpen;
}

function setChatOpen(open) {
  state.chatOpen = open;
  document.body.classList.toggle('chat-open', open);
  elements.chatToggle.setAttribute('aria-expanded', String(open));
  elements.chatBackdrop.hidden = !open;
  if (open) {
    state.unread = 0;
    updateChatBadge();
    scrollChatToBottom();
    if (!elements.chatInput.disabled) elements.chatInput.focus();
  }
}

function updateChatBadge() {
  const badge = elements.chatBadge;
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
}

function updateChatControls() {
  const canChat = Boolean(state.room) && socket.connected;
  elements.chatInput.disabled = !canChat;
  elements.chatSend.disabled = !canChat;
  elements.chatInput.placeholder = canChat ? 'Type a message…' : 'Join a room to chat';
}

function renderChat() {
  const list = elements.chatMessages;
  list.innerHTML = '';
  if (!state.chat.length) {
    const empty = document.createElement('li');
    empty.className = 'chat__empty';
    empty.textContent = state.room ? 'No messages yet.' : 'Join a room to start chatting.';
    list.appendChild(empty);
    return;
  }
  state.chat.forEach((message) => list.appendChild(buildChatItem(message)));
  scrollChatToBottom(true);
}

function appendChatMessage(message) {
  const list = elements.chatMessages;
  list.querySelector('.chat__empty')?.remove();
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.appendChild(buildChatItem(message));
  while (list.children.length > 100) list.firstElementChild.remove();
  const fromMe = message.playerId && message.playerId === state.playerId;
  if (nearBottom || fromMe) scrollChatToBottom();
}

function buildChatItem(message) {
  const li = document.createElement('li');

  if (message.type === 'system') {
    li.className = 'chat__msg chat__msg--system';
    li.textContent = message.text;
    return li;
  }

  const isMine = message.playerId === state.playerId;
  li.className = `chat__msg${isMine ? ' chat__msg--mine' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'chat__meta';
  const author = document.createElement('span');
  author.className = 'chat__author';
  author.textContent = isMine ? 'You' : message.name;
  const time = document.createElement('time');
  time.className = 'chat__time';
  const date = new Date(message.timestamp);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.append(author, time);

  const body = document.createElement('p');
  body.className = 'chat__text';
  body.textContent = message.text; // textContent prevents HTML injection

  li.append(meta, body);
  return li;
}

function scrollChatToBottom(instant = false) {
  const list = elements.chatMessages;
  requestAnimationFrame(() => {
    list.scrollTo({ top: list.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  });
}

/* ---------------- Ack helper ---------------- */

function handleAck(response) {
  if (!response) return;
  if (response.ok) {
    setStatus('');
    if (response.room) {
      state.playerId = response.playerId ?? state.playerId;
      state.room = response.room;
      elements.roomCode.value = response.room.code;
      saveSession(response.room.code);
      if (response.resumed) toast('Welcome back — you’re still in the game.');
      // Re-render everything now that we know which player we are: a room update can
      // arrive before this reply (e.g. a computer game starts instantly), and without
      // this the board would stay locked on our first turn.
      renderInfo();
      renderPlayers();
      renderWinners();
      renderCalledNumbers();
      renderCard();
      updateControls();
      updateChatControls();
      if (!state.chat.length) renderChat();
    }
  } else {
    setStatus(response.message ?? 'Something went wrong.', true);
  }
}

function renderCard() {
  elements.card.innerHTML = '';
  if (!state.card.length) {
    elements.card.innerHTML = `<p class="hint">Join or create a room to receive your card.</p>`;
    return;
  }

  const called = new Set(state.room?.calledNumbers ?? []);
  const isMyTurn = state.room?.currentPlayerId === state.playerId;
  const isGameRunning = state.room?.status === 'running';
  const player = state.room?.players.find(p => p.id === state.playerId);
  const isEliminated = player?.isEliminated;
  const size = state.boardSize || Math.round(Math.sqrt(state.card.length)) || 5;

  elements.card.style.gridTemplateColumns = `repeat(${size}, minmax(0, 1fr))`;
  elements.card.dataset.size = String(size);

  state.card.forEach((number) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.textContent = number;

    const isCalled = called.has(number);
    const isMarked = state.marked.has(number);

    if (isMarked) {
      cell.classList.add('marked');
    }
    if (isCalled) {
      cell.classList.add('called');
    }

    // Allow interaction:
    // 1. Call new number: My turn, game running, not eliminated, not called yet
    // 2. Mark number: Number is called, game running, not eliminated
    const canCallNew = isMyTurn && isGameRunning && !isEliminated && !isCalled;
    const canMark = isCalled && isGameRunning && !isEliminated;
    const canClick = canCallNew || canMark;

    if (!canClick) {
      cell.disabled = true;
      cell.style.opacity = isCalled ? '0.85' : '0.4';
    }

    if (!isCalled && isMyTurn && isGameRunning) {
      cell.title = 'Your turn – click to call this number';
    } else if (isCalled) {
      cell.title = 'Called';
    }

    const orientations = state.completedCells.get(number);
    if (orientations) {
      orientations.forEach((orientation) => {
        const stripe = document.createElement('span');
        stripe.className = `cell-stripe ${orientation}`;
        cell.appendChild(stripe);
      });
    }

    if (canClick) {
      cell.addEventListener('click', () => toggleMark(number));
    }
    elements.card.appendChild(cell);
  });
}

function toggleMark(number) {
  const player = state.room?.players.find(p => p.id === state.playerId);
  if (player?.isEliminated || player?.hasWon) {
    setStatus('You are eliminated or have already won!', true);
    return;
  }

  if (state.room?.status !== 'running') {
    setStatus('Game is not running!', true);
    return;
  }

  const called = new Set(state.room?.calledNumbers ?? []);

  if (called.has(number)) {
    if (state.marked.has(number)) {
      state.marked.delete(number);
    } else {
      state.marked.add(number);
    }
    state.completedCells = computeCompletedCells();
    renderCard();
    syncMarkedNumbersToServer();
    return;
  }

  // If number is NOT called yet, only allow calling it on your turn
  const isMyTurn = state.room?.currentPlayerId === state.playerId;
  if (!isMyTurn) {
    setStatus('Wait for your turn to call new numbers.', true);
    return;
  }

  if (state.room?.code) {
    socket.emit(
      'callSpecificNumber',
      { roomCode: state.room.code, number, markedNumbers: Array.from(state.marked) },
      (response) => {
        if (!response?.ok) {
          setStatus(response?.message ?? 'Unable to call number.', true);
        }
      }
    );
  }
}

function renderInfo() {
  const room = state.room;
  elements.infoCode.textContent = room?.code ?? '—';
  elements.topCode.textContent = room?.vsComputer ? `vs Computer · ${room.botLevel ? room.botLevel[0].toUpperCase() + room.botLevel.slice(1) : ''}` : room?.code ?? '—';
  document.body.classList.toggle('is-bot-game', Boolean(room?.vsComputer));
  elements.playersCount.textContent = room ? String(room.players.length) : '';
  elements.calledCount.textContent = room?.calledNumbers?.length ? String(room.calledNumbers.length) : '';
  elements.infoStatus.textContent = room?.status ?? 'Not connected';
  const hostId = room?.hostId;
  const hostName = room ? room.players.find((p) => p.id === hostId)?.name : undefined;
  elements.infoHost.textContent = hostName ?? '—';
  if (elements.infoBoardSize) {
    elements.infoBoardSize.textContent = `${state.boardSize} × ${state.boardSize}`;
  }

  // Show turn indicator
  if (room?.status === 'running' && room.currentPlayerId) {
    const currentPlayer = room.players.find((p) => p.id === room.currentPlayerId);
    if (currentPlayer) {
      const isMyTurn = room.currentPlayerId === state.playerId;
      const points = currentPlayer.points || 0;
      elements.turnIndicator.textContent = isMyTurn
        ? `Your turn — tap a number to call it · ${points}/5`
        : currentPlayer.isBot
          ? `${currentPlayer.name} is thinking… · ${points}/5`
          : `${currentPlayer.name}'s turn${currentPlayer.connected === false ? ' (reconnecting…)' : ''} · ${points}/5`;
      elements.turnIndicator.style.display = 'block';
      elements.turnIndicator.style.color = isMyTurn ? '#b9b7ff' : '#ededef';
    }
  } else if (room?.status === 'waiting') {
    const isHost = room.hostId === state.playerId;
    elements.turnIndicator.textContent =
      room.vsComputer && isHost
        ? 'Press Start round to play again'
        : room.players.length < 2
        ? 'Waiting for players — share the room code'
        : isHost
          ? `${room.players.length} players ready — press Start round`
          : 'Waiting for the host to start';
    elements.turnIndicator.style.display = 'block';
    elements.turnIndicator.style.color = '#8b8d98';
  } else if (room?.status === 'ended') {
    elements.turnIndicator.textContent = room.draw ? 'Draw — finished on the same call' : 'Game over — see the leaderboard';
    elements.turnIndicator.style.display = 'block';
    elements.turnIndicator.style.color = '#ededef';
  } else {
    elements.turnIndicator.style.display = 'none';
  }
}

function renderPlayers() {
  const ul = elements.players;
  ul.innerHTML = '';
  const players = state.room?.players ?? [];

  // Sort players: Host first, then by name
  const sortedPlayers = [...players].sort((a, b) => {
    if (a.isHost) return -1;
    if (b.isHost) return 1;
    return a.name.localeCompare(b.name);
  });

  sortedPlayers.forEach((player) => {
    const li = document.createElement('li');
    if (player.isCurrentTurn) li.classList.add('is-turn');

    const dot = document.createElement('span');
    dot.className = `player__dot${player.connected === false ? ' is-off' : ''}`;
    dot.title = player.connected === false ? 'Reconnecting…' : 'Online';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'player__name';
    nameSpan.textContent = `${player.name}${player.id === state.playerId ? ' (you)' : ''}`;

    const parts = [];
    if (player.isBot) parts.push('Computer');
    if (player.isHost) parts.push('Host');
    if (player.isCurrentTurn) parts.push('Turn');
    if (player.hasWon) parts.push('Finished');
    if (player.isEliminated) parts.push('Out');
    if (player.connected === false) parts.push('Reconnecting');
    const metaSpan = document.createElement('span');
    metaSpan.className = 'player__meta';
    metaSpan.textContent = parts.join(' · ');

    li.append(dot, nameSpan, metaSpan);

    if (state.room?.hostId === state.playerId && player.id !== state.playerId) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'player-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        if (confirm(`Remove ${player.name} from the room?`)) removePlayer(player.id);
      });
      li.appendChild(removeBtn);
    }

    ul.appendChild(li);
  });
}

function renderCalledNumbers() {
  const wrapper = elements.calledNumbers;
  wrapper.innerHTML = '';
  const called = state.room?.calledNumbers ?? [];
  const marked = state.marked || new Set();

  called.forEach((num) => {
    const span = document.createElement('span');
    span.textContent = num;
    if (marked.has(num)) {
      span.classList.add('marked-in-grid');
    }
    wrapper.appendChild(span);
  });
}

function renderWinners() {
  const list = elements.winners;
  list.innerHTML = '';
  const room = state.room;
  const players = [...(room?.players ?? [])];
  const rankOf = new Map((room?.winners ?? []).map((w) => [w.id, w.rank]));

  // Finished players by finishing order, then everyone else by points.
  players.sort((a, b) => {
    const ra = rankOf.get(a.id) ?? 99;
    const rb = rankOf.get(b.id) ?? 99;
    if (ra !== rb) return ra - rb;
    const diff = (b.points || 0) - (a.points || 0);
    return diff || a.name.localeCompare(b.name);
  });

  if (!players.length) {
    list.innerHTML = '<li class="lb-empty">No players yet</li>';
    return;
  }

  players.forEach((player, index) => {
    const rank = rankOf.get(player.id);
    const isLoser = room?.loser?.id === player.id;
    const li = document.createElement('li');
    li.className = 'lb-row' + (player.id === state.playerId ? ' is-me' : '') + (rank ? ' is-winner' : '') + (isLoser ? ' is-loser' : '');

    const rankEl = document.createElement('span');
    rankEl.className = 'lb-row__rank';
    rankEl.textContent = rank ?? index + 1;

    const name = document.createElement('span');
    name.className = 'lb-row__name';
    name.textContent = `${player.name}${player.id === state.playerId ? ' (you)' : ''}`;
    const tag = document.createElement('span');
    tag.className = 'lb-row__tag';
    tag.textContent = rank ? (room?.draw ? 'Draw' : (room.winners.filter((w) => w.rank === rank).length > 1 ? `Shared #${rank}` : `Finished #${rank}`)) : isLoser ? 'Last standing' : player.isCurrentTurn ? (player.id === state.playerId ? 'Your turn' : 'Their turn') : '';
    if (tag.textContent) name.appendChild(tag);

    const pts = document.createElement('span');
    pts.className = 'lb-row__pts';
    pts.innerHTML = `${player.points || 0}<small>/5</small>`;

    const bar = document.createElement('span');
    bar.className = 'lb-row__bar';
    bar.style.setProperty('--p', Math.min(1, (player.points || 0) / 5));

    li.append(rankEl, name, pts, bar);
    list.appendChild(li);
  });
}

function updateControls() {
  const room = state.room;
  const isHost = room?.hostId === state.playerId;
  const connected = Boolean(room);
  document.body.classList.toggle('in-room', connected);

  elements.startGame.disabled = !(connected && isHost && room?.status === 'waiting');
  // Only the host needs this button, and only before a round starts.
  elements.startGame.style.display = connected && isHost && room?.status === 'waiting' ? '' : 'none';

  if (elements.resetAfterGame) {
    elements.resetAfterGame.style.display = (connected && isHost) ? 'inline-block' : 'none';
    elements.resetAfterGame.disabled = !connected;
  }
}

function computeCompletedCells() {
  const map = new Map();
  const size = state.boardSize || Math.round(Math.sqrt(state.card.length)) || 5;
  if (!state.card.length) return map;

  const winPatterns = getWinPatterns(size);

  winPatterns.forEach((pattern) => {
    const numbers = pattern.map((index) => state.card[index]);
    if (numbers.every((num) => state.marked.has(num))) {
      const orientation = detectOrientation(pattern);
      numbers.forEach((num) => {
        if (!map.has(num)) {
          map.set(num, new Set());
        }
        map.get(num).add(orientation);
      });
    }
  });

  return map;
}

function detectOrientation(pattern) {
  if (pattern.length < 2) return 'horizontal';
  const delta = pattern[1] - pattern[0];
  const size = state.boardSize || Math.round(Math.sqrt(state.card.length)) || 5;
  if (delta === 1) return 'horizontal';
  if (delta === size) return 'vertical';
  if (delta === size + 1) return 'diagonal-left';
  if (delta === size - 1) return 'diagonal-right';
  return 'horizontal';
}

function syncMarkedNumbersToServer() {
  // Send marked numbers to server to check for completed lines and award points
  const expectedLength = (state.boardSize || 5) * (state.boardSize || 5);
  if (!state.room?.code || state.card.length !== expectedLength) return;

  const player = state.room?.players.find(p => p.id === state.playerId);
  if (player?.isEliminated || player?.hasWon || state.room?.status !== 'running') {
    return;
  }

  const called = new Set(state.room?.calledNumbers ?? []);
  const validMarked = Array.from(state.marked).filter(num => called.has(num));

  socket.emit('updateMarkedNumbers', {
    roomCode: state.room.code,
    markedNumbers: validMarked
  });
}

function removePlayer(targetId) {
  if (!state.room) return;
  socket.emit('removePlayer', { roomCode: state.room.code, targetId }, handleAck);
}

function getWinPatterns(size) {
  if (!winPatternCache.has(size)) {
    winPatternCache.set(size, buildWinPatterns(size));
  }
  return winPatternCache.get(size);
}

function buildWinPatterns(size) {
  const patterns = [];
  for (let r = 0; r < size; r++) {
    patterns.push(Array.from({ length: size }, (_, c) => r * size + c));
  }
  for (let c = 0; c < size; c++) {
    patterns.push(Array.from({ length: size }, (_, r) => r * size + c));
  }
  patterns.push(Array.from({ length: size }, (_, i) => i * (size + 1)));
  patterns.push(Array.from({ length: size }, (_, i) => (i + 1) * (size - 1)));
  return patterns;
}

function setStatus(message, isError = false) {
  if (elements.status) {
    elements.status.textContent = message;
    elements.status.style.color = isError ? '#e5484d' : '#8b8d98';
  }
  // In a room the lobby form is hidden, so show messages as a toast instead.
  if (state.room && message) toast(message, isError);
}
