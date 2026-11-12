const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const ROOMS = new Map();
const WIN_PATTERNS_CACHE = new Map();
const ALLOWED_BOARD_SIZES = [5, 6, 10];
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MAX_LENGTH = 300;
const CHAT_RATE_WINDOW_MS = 5000;
const CHAT_RATE_MAX = 5;
const BOT_LEVELS = ['easy', 'medium', 'hard'];
const BOT_NAMES = ['Bolt', 'Pixel', 'Nova'];
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS) || 1200;
const WIN_POINTS = 5;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 60_000;

// Link back to the Arena hub (set ARENA_URL on Render).
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ arenaUrl: process.env.ARENA_URL || '' })};`);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint (used by Render to verify the service is up)
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: ROOMS.size });
});

if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log(`Bingo server listening on http://localhost:${PORT}`);
  });
}

io.on('connection', (socket) => {
  // A player's identity is a private per-tab key (sent by the client), not the socket id,
  // so a refresh or a dropped connection can resume the same seat.
  const keyOf = () => socket.data.playerKey || socket.id;

  socket.on('resumeRoom', ({ roomCode, clientId } = {}, callback) => {
    const key = sanitizeClientId(clientId);
    const room = ROOMS.get(normalizeCode(roomCode));
    const player = key && room?.players.get(key);
    if (!player) return callback?.({ ok: false, message: 'Session expired.' });
    attachSocket(socket, room, player);
    callback?.({ ok: true, room: serializeRoom(room), playerId: player.publicId, card: player.card, resumed: true });
  });

  // Play against computer players: a private room with 1–3 bots that starts right away.
  socket.on('playComputer', ({ name, clientId, bots, difficulty, boardSize } = {}, callback) => {
    const playerName = sanitizeName(name);
    if (!playerName) return callback?.({ ok: false, message: 'Name is required.' });
    const botCount = Math.min(3, Math.max(1, Number(bots) || 1));
    const level = BOT_LEVELS.includes(difficulty) ? difficulty : 'medium';
    const size = ALLOWED_BOARD_SIZES.includes(Number(boardSize)) ? Number(boardSize) : 5;

    leaveCurrentRoom(socket);
    const key = sanitizeClientId(clientId) || socket.id;
    const roomCode = generateRoomCode();
    const room = bootstrapRoom(roomCode, key);
    room.vsComputer = true;
    room.botLevel = level;
    room.boardSize = size;
    room.winPatterns = getWinPatterns(size);
    const player = createPlayer(key, playerName, size);
    room.players.set(key, player);
    BOT_NAMES.slice(0, botCount).forEach((botName, i) => {
      const bot = createPlayer(`bot-${roomCode}-${i}`, botName, size);
      bot.isBot = true;
      bot.connected = true;
      room.players.set(bot.id, bot);
    });
    ROOMS.set(roomCode, room);

    attachSocket(socket, room, player, { silent: true });
    pushSystemMessage(room, `${player.name} vs ${botCount} computer player${botCount > 1 ? 's' : ''} (${level}).`);
    startRound(room);
    callback?.({ ok: true, room: serializeRoom(room), playerId: player.publicId });
  });

  socket.on('createRoom', ({ name, clientId } = {}, callback) => {
    const playerName = sanitizeName(name);
    if (!playerName) {
      return callback?.({ ok: false, message: 'Name is required to create a room.' });
    }

    leaveCurrentRoom(socket);
    const key = sanitizeClientId(clientId) || socket.id;
    const roomCode = generateRoomCode();
    const room = bootstrapRoom(roomCode, key);
    const player = createPlayer(key, playerName, room.boardSize);
    room.players.set(key, player);
    ROOMS.set(roomCode, room);

    attachSocket(socket, room, player, { silent: true });
    pushSystemMessage(room, `${player.name} created the room.`);
    broadcastRoom(roomCode);

    callback?.({ ok: true, room: serializeRoom(room), playerId: player.publicId });
  });

  socket.on('joinRoom', ({ name, roomCode, clientId } = {}, callback) => {
    const playerName = sanitizeName(name);
    const normalized = normalizeCode(roomCode);
    const key = sanitizeClientId(clientId) || socket.id;

    if (!playerName || !normalized) {
      return callback?.({ ok: false, message: 'Name and room code are required.' });
    }

    const room = ROOMS.get(normalized);
    if (!room) {
      return callback?.({ ok: false, message: 'Room not found.' });
    }

    // Same browser tab coming back: resume instead of joining twice.
    if (room.players.has(key)) {
      const existing = room.players.get(key);
      attachSocket(socket, room, existing);
      return callback?.({ ok: true, room: serializeRoom(room), playerId: existing.publicId, resumed: true });
    }

    if (room.vsComputer) {
      return callback?.({ ok: false, message: 'That is a game against the computer.' });
    }

    if (room.status === 'running' || room.status === 'ended') {
      return callback?.({ ok: false, message: 'Game already in progress. Wait for next round.' });
    }

    const duplicate = Array.from(room.players.values()).some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (duplicate) {
      return callback?.({ ok: false, message: 'Name already taken in this room.' });
    }

    leaveCurrentRoom(socket);
    const player = createPlayer(key, playerName, room.boardSize || 5);
    room.players.set(key, player);

    attachSocket(socket, room, player, { silent: true });
    pushSystemMessage(room, `${player.name} joined the room.`);
    broadcastRoom(room.code);

    callback?.({ ok: true, room: serializeRoom(room), playerId: player.publicId });
  });

  socket.on('changeBoardSize', ({ roomCode, size }, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.hostId !== keyOf()) {
      return callback?.({ ok: false, message: 'Only the host can change board size.' });
    }

    const parsedSize = Number(size);
    if (!ALLOWED_BOARD_SIZES.includes(parsedSize)) {
      return callback?.({ ok: false, message: 'Board size must be one of 5, 6, or 10.' });
    }

    if (room.status === 'running') {
      return callback?.({ ok: false, message: 'Wait until the round ends to change board size.' });
    }

    room.boardSize = parsedSize;
    room.winPatterns = getWinPatterns(parsedSize);
    room.calledNumbers = [];
    room.winners = [];
    room.playerOrder = Array.from(room.players.keys());
    room.currentTurnIndex = 0;
    room.loser = null;
    room.draw = false;
    room.status = 'waiting';

    for (const player of room.players.values()) {
      const newCard = generateCard(parsedSize);
      player.card = newCard;
      player.positions = mapCardPositions(newCard);
      player.marked = new Set();
      player.points = 0;
      player.completedLines = new Set();
      player.hasWon = false;
      player.isEliminated = false;
      if (player.socketId) io.to(player.socketId).emit('player:card', player.card);
    }

    broadcastRoom(room.code);
    callback?.({ ok: true, boardSize: parsedSize });
  });

  socket.on('startGame', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.hostId !== keyOf()) {
      return callback?.({ ok: false, message: 'Only the host can start the game.' });
    }

    if (room.players.size < 2) {
      return callback?.({ ok: false, message: 'Need at least 2 players to start.' });
    }

    startRound(room);
    callback?.({ ok: true });
  });

  socket.on('callNextNumber', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.hostId !== keyOf()) {
      return callback?.({ ok: false, message: 'Only the host can call numbers.' });
    }

    if (room.status !== 'running') {
      return callback?.({ ok: false, message: 'Start the game before calling numbers.' });
    }

    const boardSize = room.boardSize || 5;
    const remaining = getAllNumbers(boardSize).filter((n) => !room.calledNumbers.includes(n));
    if (!remaining.length) {
      return callback?.({ ok: false, message: 'All numbers have already been called.' });
    }

    const nextNumber = remaining[Math.floor(Math.random() * remaining.length)];
    room.calledNumbers.push(nextNumber);
    io.to(room.code).emit('number:called', nextNumber);

    broadcastRoom(room.code);
    callback?.({ ok: true, number: nextNumber });
  });

  socket.on('callSpecificNumber', ({ roomCode, number, markedNumbers }, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.status !== 'running') {
      return callback?.({ ok: false, message: 'Start the round before calling numbers.' });
    }

    const player = room.players.get(keyOf());
    if (!player) {
      return callback?.({ ok: false, message: 'Player not found.' });
    }

    if (player.isEliminated || player.hasWon) {
      return callback?.({ ok: false, message: 'You are eliminated or have already won. Wait for the game to end.' });
    }

    const currentPlayerId = room.playerOrder[room.currentTurnIndex];
    if (keyOf() !== currentPlayerId) {
      const currentPlayer = room.players.get(currentPlayerId);
      return callback?.({ ok: false, message: `It's ${currentPlayer?.name || 'someone else'}'s turn.` });
    }

    const boardSize = room.boardSize || 5;
    const maxNumber = boardSize * boardSize;
    const numeric = Number(number);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > maxNumber) {
      return callback?.({ ok: false, message: `Pick a number between 1 and ${maxNumber}.` });
    }

    if (!player.card.includes(numeric)) {
      return callback?.({ ok: false, message: 'Select a number from your own card.' });
    }

    if (room.calledNumbers.includes(numeric)) {
      return callback?.({ ok: false, message: 'That number is already called.' });
    }

    callNumber(room, numeric);
    callback?.({ ok: true, number: numeric });
  });

  // Kept for older clients. Marks are set by the server when a number is called,
  // so this only re-sends the current state and can never score or win a game.
  socket.on('updateMarkedNumbers', ({ roomCode } = {}) => {
    const room = ROOMS.get(normalizeCode(roomCode));
    if (!room || !room.players.has(keyOf())) return;
    socket.emit('room:update', serializeRoom(room));
  });

  socket.on('resetGame', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.hostId !== keyOf()) {
      return callback?.({ ok: false, message: 'Only the host can reset the game.' });
    }

    resetRoom(room);
    room.status = 'waiting';
    broadcastRoom(room.code);
    callback?.({ ok: true });
  });

  socket.on('removePlayer', ({ roomCode, targetId } = {}, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    if (room.hostId !== keyOf()) {
      return callback?.({ ok: false, message: 'Only the host can remove players.' });
    }

    const target = [...room.players.values()].find((p) => p.publicId === targetId);
    if (!target) {
      return callback?.({ ok: false, message: 'Player not found in this room.' });
    }
    targetId = target.id;

    if (targetId === keyOf()) {
      return callback?.({ ok: false, message: 'Host cannot remove themselves.' });
    }

    forceRemovePlayer(room, targetId, 'Removed by host');
    callback?.({ ok: true });
  });

  socket.on('chat:typing', ({ roomCode, typing } = {}) => {
    const code = normalizeCode(roomCode);
    const room = code && ROOMS.get(code);
    if (!room || !room.players.has(keyOf())) return;
    const player = room.players.get(keyOf());
    socket.to(room.code).emit('chat:typing', {
      playerId: player.publicId,
      name: player.name,
      typing: Boolean(typing),
    });
  });

  socket.on('chat:send', ({ roomCode, text } = {}, callback) => {
    const room = findRoomForSocket(roomCode, keyOf(), callback);
    if (!room) return;

    const player = room.players.get(keyOf());
    const message = sanitizeChatText(text);
    if (!message) {
      return callback?.({ ok: false, message: 'Message cannot be empty.' });
    }

    // Simple per-player rate limit to prevent spam
    const now = Date.now();
    player.chatTimestamps = (player.chatTimestamps || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    if (player.chatTimestamps.length >= CHAT_RATE_MAX) {
      return callback?.({ ok: false, message: 'You are sending messages too fast.' });
    }
    player.chatTimestamps.push(now);

    pushChatMessage(room, {
      id: uuid(),
      type: 'user',
      playerId: player.publicId,
      name: player.name,
      text: message,
      timestamp: now,
    });
    socket.to(room.code).emit('chat:typing', { playerId: player.publicId, name: player.name, typing: false });
    callback?.({ ok: true });
  });

  socket.on('leaveRoom', (_payload, callback) => {
    leaveCurrentRoom(socket);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const key = keyOf();
    const room = findRoomByPlayer(key);
    const player = room?.players.get(key);
    if (!player || player.socketId !== socket.id) return; // already reconnected elsewhere
    player.connected = false;
    player.socketId = null;
    io.to(room.code).emit('chat:typing', { playerId: player.publicId, name: player.name, typing: false });
    broadcastRoom(room.code);
    // Keep the seat for a while so a refresh or network blip doesn't lose the game.
    clearTimeout(player.graceTimer);
    player.graceTimer = setTimeout(() => removePlayerFromRoom(room, key, 'Player disconnected'), RECONNECT_GRACE_MS);
    player.graceTimer.unref?.();
  });
});

// Records a player's marks and awards points for newly completed lines.
// Returns true when the player has just reached the winning score; the caller
// settles every finisher of the same call together (see settleFinishers).
function applyMarks(room, player, markedNumbers) {
  const winPatterns = room.winPatterns || getWinPatterns(room.boardSize || 5);

  // Only called numbers on the player's own card can be marked.
  const calledSet = new Set(room.calledNumbers);
  const validMarks = (Array.isArray(markedNumbers) ? markedNumbers : [...markedNumbers || []]).filter(
    (n) => player.positions.has(n) && calledSet.has(n)
  );
  player.marked = new Set(validMarks);

  const markSet = new Set(validMarks.map((n) => player.positions.get(n)));
  const newLines = checkNewLines(player, markSet, winPatterns);
  if (!newLines.length) return false;

  player.points += newLines.length;
  newLines.forEach((lineIndex) => player.completedLines.add(lineIndex));
  io.to(room.code).emit('room:pointsEarned', {
    player: player.name,
    points: player.points,
    linesCompleted: newLines.length,
  });
  return player.points >= WIN_POINTS && !player.hasWon;
}

// Everyone who reached the winning score on the same call finishes together and
// shares the same place. Network timing never decides who won.
function settleFinishers(room, finishers) {
  if (!finishers.length) return;
  const rank = room.winners.length + 1;
  const now = Date.now();
  for (const player of finishers) {
    player.hasWon = true;
    room.winners.push({ id: player.publicId, name: player.name, rank, points: player.points, timestamp: now });
  }
  io.to(room.code).emit('room:playerWon', {
    player: finishers.map((p) => p.name).join(' & '),
    players: finishers.map((p) => p.name),
    rank,
    tie: finishers.length > 1,
    winners: room.winners,
  });

  const active = room.playerOrder.filter(
    (id) => room.players.has(id) && !room.players.get(id).isEliminated && !room.players.get(id).hasWon
  );
  if (active.length <= 1) {
    const loser = active.length === 1 ? room.players.get(active[0]) : null;
    room.loser = loser ? { id: loser.publicId, name: loser.name } : null;
    room.draw = !loser && room.winners.every((w) => w.rank === 1);
    room.status = 'ended';
    clearTimeout(room.botTimer);
    io.to(room.code).emit('room:gameEnded', { loser: loser?.name, draw: room.draw, winners: room.winners });
  }
}

function startRound(room) {
  resetRoom(room);
  room.status = 'running';
  room.winPatterns = getWinPatterns(room.boardSize || 5);
  room.playerOrder = Array.from(room.players.keys());
  shuffleArray(room.playerOrder);
  room.currentTurnIndex = 0;
  room.loser = null;

  for (const player of room.players.values()) {
    const newCard = generateCard(room.boardSize || 5);
    player.card = newCard;
    player.positions = mapCardPositions(newCard);
    player.marked.clear();
    player.points = 0;
    player.completedLines.clear();
    player.hasWon = false;
    player.isEliminated = false;
    if (player.socketId) io.to(player.socketId).emit('player:card', player.card);
  }
  broadcastRoom(room.code);
  scheduleBotTurn(room);
}

// Calls a number for the room: everyone with it gets it marked (computer players
// immediately; people mark it in their browser), then the turn moves on.
function callNumber(room, number) {
  room.calledNumbers.push(number);
  io.to(room.code).emit('number:called', number);
  // The server marks every card (people and computer players alike) in one pass,
  // then settles all players who finished on this call at the same time.
  const finishers = [];
  for (const player of room.players.values()) {
    if (player.hasWon || player.isEliminated || !player.positions.has(number)) continue;
    if (applyMarks(room, player, [...player.marked, number])) finishers.push(player);
  }
  settleFinishers(room, finishers);
  if (room.status === 'running') advanceTurn(room);
  broadcastRoom(room.code);
  scheduleBotTurn(room);
}

// If it's a computer player's turn, make its move after a short "thinking" pause.
function scheduleBotTurn(room) {
  clearTimeout(room.botTimer);
  if (room.status !== 'running') return;
  const currentId = room.playerOrder[room.currentTurnIndex];
  const bot = room.players.get(currentId);
  if (!bot?.isBot) return;
  const delay = BOT_DELAY_MS + Math.floor(Math.random() * (BOT_DELAY_MS / 2));
  room.botTimer = setTimeout(() => {
    if (!ROOMS.has(room.code) || room.status !== 'running') return;
    if (room.playerOrder[room.currentTurnIndex] !== bot.id) return;
    const number = chooseBotNumber(room, bot);
    if (number == null) {
      advanceTurn(room);
      broadcastRoom(room.code);
      scheduleBotTurn(room);
      return;
    }
    callNumber(room, number);
  }, delay);
  room.botTimer.unref?.();
}

// Easy: random. Medium: push its most-complete line. Hard: build several lines at once
// and always finish a line when it can. Bots only look at their own card.
function chooseBotNumber(room, bot) {
  const called = new Set(room.calledNumbers);
  const options = bot.card.filter((n) => !called.has(n));
  if (!options.length) return null;
  const level = room.botLevel || 'medium';
  if (level === 'easy') return options[Math.floor(Math.random() * options.length)];

  const size = room.boardSize || 5;
  const patterns = room.winPatterns || getWinPatterns(size);
  const markedIdx = new Set([...bot.marked].map((n) => bot.positions.get(n)));
  let best = -Infinity;
  let choices = [];
  for (const n of options) {
    const idx = bot.positions.get(n);
    let score = 0;
    patterns.forEach((pattern, i) => {
      if (bot.completedLines.has(i) || !pattern.includes(idx)) return;
      const have = pattern.filter((cell) => markedIdx.has(cell)).length;
      if (level === 'medium') score = Math.max(score, have);
      else score += have * have + (have === size - 1 ? 1000 : 0);
    });
    if (score > best) {
      best = score;
      choices = [n];
    } else if (score === best) {
      choices.push(n);
    }
  }
  return choices[Math.floor(Math.random() * choices.length)];
}

function resetRoom(room) {
  clearTimeout(room.botTimer);
  room.calledNumbers = [];
  room.winners = [];
  room.playerOrder = [];
  room.currentTurnIndex = 0;
  room.loser = null;
  room.draw = false;
  for (const player of room.players.values()) {
    player.marked = new Set();
    player.points = 0;
    player.completedLines = new Set();
    player.hasWon = false;
    player.isEliminated = false;
  }
}

function advanceTurn(room) {
  if (room.status !== 'running') return;

  const activePlayers = room.playerOrder.filter(
    (id) => room.players.has(id) && !room.players.get(id).isEliminated && !room.players.get(id).hasWon
  );

  if (activePlayers.length <= 1) {
    // Last player loses (if no one reached 5 points)
    if (activePlayers.length === 1) {
      const loser = room.players.get(activePlayers[0]);
      room.loser = { id: loser.publicId, name: loser.name };
      io.to(room.code).emit('room:gameEnded', {
        loser: loser.name,
        winner: null,
        winners: room.winners
      });
    }
    room.status = 'ended';
    return;
  }

  // Find next active player (not eliminated, not won)
  let attempts = 0;
  do {
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.playerOrder.length;
    attempts++;
    if (attempts > room.playerOrder.length) break;
  } while (
    !room.players.has(room.playerOrder[room.currentTurnIndex]) ||
    room.players.get(room.playerOrder[room.currentTurnIndex]).isEliminated ||
    room.players.get(room.playerOrder[room.currentTurnIndex]).hasWon
  );
}

function forceRemovePlayer(room, playerId, reason = 'Removed by host') {
  const target = room.players.get(playerId);
  if (!target) return;
  if (target.socketId) io.to(target.socketId).emit('player:kicked', reason);
  const targetSocket = target.socketId && io.sockets.sockets.get(target.socketId);
  if (targetSocket) targetSocket.data.roomCode = null;
  targetSocket?.leave(room.code);
  // Remove first so the disconnect handler doesn't report it as a normal leave
  removePlayerFromRoom(room, playerId, reason);
  targetSocket?.disconnect(true);
}

function removePlayerFromRoom(room, playerId, reason = 'Player removed') {
  if (!room.players.has(playerId)) return;

  const leaving = room.players.get(playerId);
  const leavingName = leaving?.name;
  clearTimeout(leaving?.graceTimer);
  room.players.delete(playerId);
  // A computer game ends when its last person leaves.
  if (![...room.players.values()].some((p) => !p.isBot)) {
    clearTimeout(room.botTimer);
    ROOMS.delete(room.code);
    return;
  }
  io.to(room.code).emit('chat:typing', { playerId: leaving?.publicId, name: leavingName, typing: false });
  const orderIndex = room.playerOrder.indexOf(playerId);
  if (orderIndex !== -1) {
    room.playerOrder.splice(orderIndex, 1);
    if (room.currentTurnIndex >= room.playerOrder.length) {
      room.currentTurnIndex = 0;
    }
  }

  if (room.players.size === 0) {
    ROOMS.delete(room.code);
    return;
  }

  if (leavingName) {
    const suffix = reason === 'Removed by host' ? ' was removed by the host.' : ' left the room.';
    pushSystemMessage(room, `${leavingName}${suffix}`);
  }

  if (room.hostId === playerId) {
    room.hostId = room.players.has(room.playerOrder[0])
      ? room.playerOrder[0]
      : room.players.keys().next().value;
    io.to(room.code).emit('room:hostChanged', room.players.get(room.hostId)?.name || 'Host');
  }

  if (room.status === 'running') {
    advanceTurn(room);
  }
  scheduleBotTurn(room);

  broadcastRoom(room.code);
}


function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function findRoomForSocket(roomCode, socketId, callback) {
  const code = normalizeCode(roomCode);
  if (!code) {
    callback?.({ ok: false, message: 'Room code is required.' });
    return null;
  }
  const room = ROOMS.get(code);
  if (!room) {
    callback?.({ ok: false, message: 'Room not found.' });
    return null;
  }
  if (!room.players.has(socketId)) {
    callback?.({ ok: false, message: 'You are not part of this room.' });
    return null;
  }
  return room;
}

function findRoomByPlayer(playerId) {
  for (const room of ROOMS.values()) {
    if (room.players.has(playerId)) {
      return room;
    }
  }
  return null;
}

function generateRoomCode() {
  return uuid().split('-')[0].slice(0, 4).toUpperCase();
}

function bootstrapRoom(code, hostId) {
  const boardSize = 5;
  return {
    code,
    hostId,
    status: 'waiting',
    players: new Map(),
    calledNumbers: [],
    winners: [],
    playerOrder: [],
    currentTurnIndex: 0,
    loser: null,
    boardSize,
    winPatterns: getWinPatterns(boardSize),
    chat: [],
  };
}

function pushChatMessage(room, message) {
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_LIMIT) {
    room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
  }
  io.to(room.code).emit('chat:message', message);
}

function pushSystemMessage(room, text) {
  pushChatMessage(room, {
    id: uuid(),
    type: 'system',
    text,
    timestamp: Date.now(),
  });
}

function sanitizeChatText(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

function createPlayer(id, name, boardSize = 5) {
  const card = generateCard(boardSize);
  return {
    id, // private key — never sent to other clients
    publicId: uuid(),
    socketId: null,
    connected: true,
    graceTimer: null,
    name,
    card,
    positions: mapCardPositions(card),
    marked: new Set(),
    points: 0,
    completedLines: new Set(), // Track which lines have been completed (to avoid double-counting)
    hasWon: false,
    isEliminated: false,
  };
}

function generateCard(size = 5) {
  const pool = getAllNumbers(size);
  const card = [];
  const total = size * size;
  while (card.length < total) {
    const idx = Math.floor(Math.random() * pool.length);
    card.push(pool.splice(idx, 1)[0]);
  }
  return card;
}

function mapCardPositions(card) {
  const map = new Map();
  card.forEach((num, idx) => map.set(num, idx));
  return map;
}

function broadcastRoom(roomCode) {
  const room = ROOMS.get(roomCode);
  if (!room) return;
  io.to(room.code).emit('room:update', serializeRoom(room));
}

function serializeRoom(room) {
  const currentPlayerId = room.playerOrder[room.currentTurnIndex] || null;
  const publicOf = (key) => room.players.get(key)?.publicId || null;
  return {
    code: room.code,
    status: room.status,
    hostId: publicOf(room.hostId),
    vsComputer: Boolean(room.vsComputer),
    botLevel: room.botLevel || null,
    currentPlayerId: publicOf(currentPlayerId),
    boardSize: room.boardSize,
    calledNumbers: room.calledNumbers,
    winners: room.winners,
    loser: room.loser,
    draw: Boolean(room.draw),
    players: Array.from(room.players.values()).map((player) => ({
      id: player.publicId,
      name: player.name,
      connected: player.connected,
      isBot: Boolean(player.isBot),
      isHost: player.id === room.hostId,
      points: player.points,
      hasWon: player.hasWon,
      isEliminated: player.isEliminated,
      isCurrentTurn: player.id === currentPlayerId,
      marked: Array.from(player.marked),
    })),
  };
}

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s{2,}/g, ' ')
    .slice(0, 20);
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

function checkNewLines(player, markSet, winPatterns) {
  const newLines = [];
  winPatterns.forEach((pattern, patternIndex) => {
    // Check if this line is already completed (prevent double-counting)
    if (player.completedLines.has(patternIndex)) {
      return;
    }
    // Check if all positions in this pattern are marked
    if (pattern.every((idx) => markSet.has(idx))) {
      newLines.push(patternIndex);
    }
  });
  return newLines;
}

function getAllNumbers(size) {
  return Array.from({ length: size * size }, (_, i) => i + 1);
}

function getWinPatterns(size) {
  if (!WIN_PATTERNS_CACHE.has(size)) {
    WIN_PATTERNS_CACHE.set(size, buildWinPatterns(size));
  }
  return WIN_PATTERNS_CACHE.get(size);
}

function buildWinPatterns(size) {
  const patterns = [];
  // rows
  for (let r = 0; r < size; r++) {
    patterns.push(Array.from({ length: size }, (_, c) => r * size + c));
  }
  // columns
  for (let c = 0; c < size; c++) {
    patterns.push(Array.from({ length: size }, (_, r) => r * size + c));
  }
  // diagonals
  patterns.push(Array.from({ length: size }, (_, i) => i * (size + 1))); // top-left to bottom-right
  patterns.push(Array.from({ length: size }, (_, i) => (i + 1) * (size - 1))); // top-right to bottom-left
  return patterns;
}

function sanitizeClientId(id) {
  const value = String(id ?? '');
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

// Points a socket at a player's seat (new join, refresh or reconnect).
function attachSocket(socket, room, player, { silent = false } = {}) {
  clearTimeout(player.graceTimer);
  player.graceTimer = null;
  const previous = player.socketId && player.socketId !== socket.id && io.sockets.sockets.get(player.socketId);
  if (previous) {
    previous.data.roomCode = null;
    previous.data.playerKey = null;
    previous.leave(room.code);
    previous.emit('player:replaced');
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.playerKey = player.id;
  socket.data.roomCode = room.code;
  socket.join(room.code);
  socket.emit('player:card', player.card);
  socket.emit('chat:history', room.chat);
  if (!silent) broadcastRoom(room.code);
}

function leaveCurrentRoom(socket) {
  const key = socket.data.playerKey;
  const room = socket.data.roomCode && ROOMS.get(socket.data.roomCode);
  if (!room || !key || !room.players.has(key)) return;
  socket.leave(room.code);
  socket.data.roomCode = null;
  removePlayerFromRoom(room, key, 'Player left');
}

module.exports = { app, callNumber, createPlayer, bootstrapRoom, startRound, httpServer, io, ROOMS, chooseBotNumber, buildWinPatterns, sanitizeName, normalizeCode, sanitizeClientId };
