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

app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint (used by Render to verify the service is up)
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: ROOMS.size });
});

httpServer.listen(PORT, () => {
  console.log(`Bingo server listening on http://localhost:${PORT}`);
});

io.on('connection', (socket) => {
  console.log(`Client connected ${socket.id}`);

  socket.on('createRoom', ({ name }, callback) => {
    const playerName = sanitizeName(name);
    if (!playerName) {
      return callback?.({ ok: false, message: 'Name is required to create a room.' });
    }

    const roomCode = generateRoomCode();
    const room = bootstrapRoom(roomCode, socket.id);
    const player = createPlayer(socket.id, playerName, room.boardSize);
    room.players.set(socket.id, player);
    ROOMS.set(roomCode, room);

    socket.join(roomCode);
    socket.emit('player:card', player.card);
    socket.emit('chat:history', room.chat);
    pushSystemMessage(room, `${player.name} created the room.`);
    broadcastRoom(roomCode);

    callback?.({ ok: true, room: serializeRoom(room), playerId: socket.id });
  });

  socket.on('joinRoom', ({ name, roomCode }, callback) => {
    const playerName = sanitizeName(name);
    const normalized = normalizeCode(roomCode);

    if (!playerName || !normalized) {
      return callback?.({ ok: false, message: 'Name and room code are required.' });
    }

    const room = ROOMS.get(normalized);
    if (!room) {
      return callback?.({ ok: false, message: 'Room not found.' });
    }

    if (room.status === 'running' || room.status === 'ended') {
      return callback?.({ ok: false, message: 'Game already in progress. Wait for next round.' });
    }

    if (room.players.has(socket.id)) {
      return callback?.({ ok: true, room: serializeRoom(room), playerId: socket.id });
    }

    const duplicate = Array.from(room.players.values()).some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (duplicate) {
      return callback?.({ ok: false, message: 'Name already taken in this room.' });
    }

    const player = createPlayer(socket.id, playerName, room.boardSize || 5);
    room.players.set(socket.id, player);

    socket.join(room.code);
    socket.emit('player:card', player.card);
    socket.emit('chat:history', room.chat);
    pushSystemMessage(room, `${player.name} joined the room.`);
    broadcastRoom(room.code);

    callback?.({ ok: true, room: serializeRoom(room), playerId: socket.id });
  });

  socket.on('changeBoardSize', ({ roomCode, size }, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.hostId !== socket.id) {
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
      io.to(player.id).emit('player:card', player.card);
    }

    broadcastRoom(room.code);
    callback?.({ ok: true, boardSize: parsedSize });
  });

  socket.on('startGame', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, message: 'Only the host can start the game.' });
    }

    if (room.players.size < 2) {
      return callback?.({ ok: false, message: 'Need at least 2 players to start.' });
    }

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
      io.to(player.id).emit('player:card', player.card);
    }

    broadcastRoom(room.code);
    callback?.({ ok: true });
  });

  socket.on('callNextNumber', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.hostId !== socket.id) {
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
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.status !== 'running') {
      return callback?.({ ok: false, message: 'Start the round before calling numbers.' });
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return callback?.({ ok: false, message: 'Player not found.' });
    }

    if (player.isEliminated || player.hasWon) {
      return callback?.({ ok: false, message: 'You are eliminated or have already won. Wait for the game to end.' });
    }

    const currentPlayerId = room.playerOrder[room.currentTurnIndex];
    if (socket.id !== currentPlayerId) {
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

    // Add number to called list
    room.calledNumbers.push(numeric);
    io.to(room.code).emit('number:called', numeric);

    // Advance turn to next active player
    advanceTurn(room);

    broadcastRoom(room.code);
    callback?.({ ok: true, number: numeric });
  });

  socket.on('updateMarkedNumbers', ({ roomCode, markedNumbers }) => {
    const code = normalizeCode(roomCode);
    if (!code) return;
    const room = ROOMS.get(code);
    if (!room || room.status !== 'running') return;
    if (!room.players.has(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player || player.isEliminated || player.hasWon) return;

    const winPatterns = room.winPatterns || getWinPatterns(room.boardSize || 5);

    // Update player's marked numbers (only called numbers can be marked)
    const calledSet = new Set(room.calledNumbers);
    const validMarks = (Array.isArray(markedNumbers) ? markedNumbers : []).filter(
      (n) => player.positions.has(n) && calledSet.has(n)
    );
    player.marked = new Set(validMarks);

    // Check for newly completed lines (Auto-Scoring)
    const markIndices = validMarks.map((n) => player.positions.get(n));
    const markSet = new Set(markIndices);
    const newLines = checkNewLines(player, markSet, winPatterns);

    if (newLines.length > 0) {
      player.points += newLines.length;
      newLines.forEach(lineIndex => player.completedLines.add(lineIndex));

      io.to(room.code).emit('room:pointsEarned', {
        player: player.name,
        points: player.points,
        linesCompleted: newLines.length
      });

      // Check for win condition (5 points)
      if (player.points >= 5 && !player.hasWon) {
        player.hasWon = true;
        const rank = room.winners.length + 1;
        room.winners.push({
          id: player.id,
          name: player.name,
          rank,
          timestamp: Date.now()
        });

        io.to(room.code).emit('room:playerWon', {
          player: player.name,
          rank,
          winners: room.winners
        });

        // Check if game should end (only 1 player left)
        const activePlayers = room.playerOrder.filter(
          (id) => room.players.has(id) && !room.players.get(id).isEliminated && !room.players.get(id).hasWon
        );

        if (activePlayers.length <= 1) {
          // Game Over
          const loserId = activePlayers[0];
          const loser = room.players.get(loserId);
          if (loser) {
            room.loser = { id: loser.id, name: loser.name };
          }
          room.status = 'ended';
          io.to(room.code).emit('room:gameEnded', {
            loser: loser?.name,
            winners: room.winners
          });
        }
      }
    }

    broadcastRoom(room.code);
  });

  socket.on('resetGame', ({ roomCode }, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, message: 'Only the host can reset the game.' });
    }

    resetRoom(room);
    room.status = 'waiting';
    broadcastRoom(room.code);
    callback?.({ ok: true });
  });

  socket.on('removePlayer', ({ roomCode, targetId }, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, message: 'Only the host can remove players.' });
    }

    if (!room.players.has(targetId)) {
      return callback?.({ ok: false, message: 'Player not found in this room.' });
    }

    if (targetId === socket.id) {
      return callback?.({ ok: false, message: 'Host cannot remove themselves.' });
    }

    forceRemovePlayer(room, targetId, 'Removed by host');
    callback?.({ ok: true });
  });

  socket.on('chat:send', ({ roomCode, text } = {}, callback) => {
    const room = findRoomForSocket(roomCode, socket.id, callback);
    if (!room) return;

    const player = room.players.get(socket.id);
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
      playerId: player.id,
      name: player.name,
      text: message,
      timestamp: now,
    });
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected ${socket.id}`);
    const room = findRoomByPlayer(socket.id);
    if (!room) return;
    removePlayerFromRoom(room, socket.id, 'Player disconnected');
  });
});

function resetRoom(room) {
  room.calledNumbers = [];
  room.winners = [];
  room.playerOrder = [];
  room.currentTurnIndex = 0;
  room.loser = null;
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
      room.loser = { id: loser.id, name: loser.name };
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
  if (!room.players.has(playerId)) return;
  io.to(playerId).emit('player:kicked', reason);
  const targetSocket = io.sockets.sockets.get(playerId);
  targetSocket?.leave(room.code);
  // Remove first so the disconnect handler doesn't report it as a normal leave
  removePlayerFromRoom(room, playerId, reason);
  targetSocket?.disconnect(true);
}

function removePlayerFromRoom(room, playerId, reason = 'Player removed') {
  if (!room.players.has(playerId)) return;

  const leavingName = room.players.get(playerId)?.name;
  room.players.delete(playerId);
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
    id,
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
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    boardSize: room.boardSize,
    calledNumbers: room.calledNumbers,
    winners: room.winners,
    loser: room.loser,
    currentPlayerId,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
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

