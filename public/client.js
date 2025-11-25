const socket = io();

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
};

const state = {
  playerId: null,
  room: null,
  card: [],
  marked: new Set(),
  completedCells: new Map(),
  boardSize: 5,
};

const winPatternCache = new Map();

elements.createRoom.addEventListener('click', () => {
  socket.emit('createRoom', { name: elements.name.value }, handleAck);
});

elements.joinRoom.addEventListener('click', () => {
  socket.emit(
    'joinRoom',
    { name: elements.name.value, roomCode: elements.roomCode.value },
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
  if (!state.playerId && room.players.find((p) => p.id === socket.id)) {
    state.playerId = socket.id;
  }

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

socket.on('room:gameEnded', ({ winner, loser, winners: winnerList }) => {
  if (loser) {
    setStatus(`Game Over! ${loser} is the loser.`, false);
  } else if (winner) {
    // This might be a legacy event or single winner case, but we handle multi-winner via room:playerWon
    setStatus(`${winner} finished!`, false);
  }
});

socket.on('room:playerWon', ({ player, rank }) => {
  setStatus(`${player} finished #${rank}!`, false);
});

socket.on('room:hostChanged', (name) => {
  setStatus(`${name} is now the host.`, false);
});

socket.on('connect_error', () => {
  setStatus('Unable to reach server. Make sure it is running.', true);
});

socket.on('player:kicked', (reason) => {
  alert(reason || 'You were removed from the room by the host.');
  window.location.reload();
});

function handleAck(response) {
  if (!response) return;
  if (response.ok) {
    setStatus('');
    if (response.room) {
      state.playerId = response.playerId ?? state.playerId ?? socket.id;
      state.room = response.room;
      elements.roomCode.value = response.room.code;
      renderInfo();
      renderPlayers();
      updateControls();
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

  const minCellSize = size >= 10 ? 32 : size >= 6 ? 48 : 70;
  elements.card.style.gridTemplateColumns = `repeat(${size}, minmax(${minCellSize}px, 1fr))`;

  state.card.forEach((number) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.textContent = number;
    cell.style.fontSize = size >= 10 ? '0.85rem' : size >= 6 ? '1.05rem' : '1.4rem';

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
        ? `🎯 Your Turn! (${points}/5 points)`
        : `👤 ${currentPlayer.name}'s Turn (${points}/5 points)`;
      elements.turnIndicator.style.display = 'block';
      elements.turnIndicator.style.color = isMyTurn ? '#34d399' : '#fbbf24';
    }
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
    const isCurrentTurn = player.isCurrentTurn;
    const isEliminated = player.isEliminated;
    const points = player.points || 0;
    let status = '';
    if (isEliminated) {
      status = '❌ Eliminated';
    } else if (isCurrentTurn) {
      status = '🎯 Your Turn';
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${player.name}${player.id === state.playerId ? ' (you)' : ''}`;

    const metaSpan = document.createElement('span');
    metaSpan.innerHTML = `
      ${player.isHost ? 'Host · ' : ''}
      ${points > 0 ? `⭐ ${points}/5 · ` : ''}
      ${status}
    `;

    li.appendChild(nameSpan);
    li.appendChild(metaSpan);

    if (state.room?.hostId === state.playerId && player.id !== state.playerId) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'player-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removePlayer(player.id));
      li.appendChild(removeBtn);
    }

    if (isEliminated) {
      li.style.opacity = '0.6';
      li.style.textDecoration = 'line-through';
    } else if (player.hasWon) {
      li.style.background = 'rgba(34, 197, 94, 0.3)';
      li.style.fontWeight = 'bold';
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
  const players = [...(state.room?.players ?? [])];

  // Sort by points (descending), then by name
  players.sort((a, b) => {
    const pointsA = a.points || 0;
    const pointsB = b.points || 0;
    if (pointsB !== pointsA) return pointsB - pointsA;
    return a.name.localeCompare(b.name);
  });

  if (players.length === 0) {
    list.innerHTML = '<li style="opacity: 0.6;">No players yet</li>';
    return;
  }

  players.forEach((player, index) => {
    const li = document.createElement('li');
    const points = player.points || 0;
    const isWinner = player.hasWon;
    const isLoser = state.room?.loser?.id === player.id;
    let display = `${index + 1}. ${player.name} - ${points}/5 points`;
    if (isWinner) {
      display = `🏆 ${display} - WINNER!`;
      li.style.color = '#34d399';
      li.style.fontWeight = 'bold';
    } else if (isLoser) {
      display = `❌ ${display} - Better Luck Next Time! �`;
      li.style.color = '#ef4444';
    }
    li.textContent = display;
    list.appendChild(li);
  });
}

function updateControls() {
  const room = state.room;
  const isHost = room?.hostId === state.playerId;
  const connected = Boolean(room);

  elements.startGame.disabled = !(connected && isHost && room?.status === 'waiting');

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
    elements.status.style.color = isError ? '#ef4444' : '#10b981';
  }
}
