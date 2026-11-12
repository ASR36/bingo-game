const test = require('node:test');
const assert = require('node:assert/strict');
process.env.RECONNECT_GRACE_MS = '300';
process.env.BOT_DELAY_MS = '15';
const { io: connect } = require('socket.io-client');
const { httpServer, io, ROOMS, chooseBotNumber, buildWinPatterns, normalizeCode, sanitizeClientId } = require('../server/index');

let url;
const sockets = [];

test.before(async () => {
  await new Promise((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${httpServer.address().port}`;
});

test.after(async () => {
  sockets.forEach((s) => s.close());
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

function client() {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}
const emit = (s, event, payload = {}) => new Promise((resolve) => s.emit(event, payload, resolve));
const once = (s, event) => new Promise((resolve) => s.once(event, resolve));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cid = (n) => `test-${n}-${Math.random().toString(36).slice(2, 10)}`;

test('health check and static files', async () => {
  for (const path of ['/healthz', '/', '/client.js', '/styles.css', '/config.js']) {
    assert.equal((await fetch(url + path)).status, 200, path);
  }
});

test('create and join a room; ids sent to clients are public, not private keys', async () => {
  const a = client();
  const b = client();
  const aId = cid('a');
  const created = await emit(a, 'createRoom', { name: 'Alice', clientId: aId });
  assert.equal(created.ok, true);
  const joined = await emit(b, 'joinRoom', { name: 'Bob', roomCode: created.room.code, clientId: cid('b') });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.players.length, 2);
  assert.notEqual(created.playerId, aId, 'private key must not be used as the public id');
  assert.ok(!JSON.stringify(joined.room).includes(aId), 'private key must never be broadcast');
  assert.equal(joined.room.hostId, created.playerId);
});

test('refresh keeps your seat: resume returns the same player and card', async () => {
  const a = client();
  const b = client();
  const aId = cid('a');
  const cardPromise = once(a, 'player:card');
  const created = await emit(a, 'createRoom', { name: 'Host', clientId: aId });
  const card = await cardPromise;
  await emit(b, 'joinRoom', { name: 'Guest', roomCode: created.room.code, clientId: cid('b') });
  assert.equal((await emit(a, 'startGame', { roomCode: created.room.code })).ok, true);

  // Simulate a refresh: drop the socket and come back with the same client id.
  a.close();
  await wait(50);
  const a2 = client();
  const newCard = once(a2, 'player:card');
  const resumed = await emit(a2, 'resumeRoom', { roomCode: created.room.code, clientId: aId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, created.playerId);
  assert.equal(resumed.room.status, 'running');
  assert.equal(resumed.room.players.length, 2);
  assert.equal((await newCard).length, card.length);
  assert.equal(resumed.room.hostId, created.playerId, 'still the host');
});

test('a player who does not come back is removed after the grace period', async () => {
  const a = client();
  const b = client();
  const created = await emit(a, 'createRoom', { name: 'Stay', clientId: cid('a') });
  await emit(b, 'joinRoom', { name: 'Gone', roomCode: created.room.code, clientId: cid('b') });
  const update = new Promise((resolve) =>
    a.on('room:update', (room) => room.players.length === 1 && resolve(room))
  );
  b.close();
  const room = await update;
  assert.equal(room.players[0].name, 'Stay');
});

test('rejoining by code with the same tab resumes even mid-game', async () => {
  const a = client();
  const b = client();
  const bId = cid('b');
  const created = await emit(a, 'createRoom', { name: 'P1', clientId: cid('a') });
  const joined = await emit(b, 'joinRoom', { name: 'P2', roomCode: created.room.code, clientId: bId });
  await emit(a, 'startGame', { roomCode: created.room.code });
  b.close();
  const b2 = client();
  const again = await emit(b2, 'joinRoom', { name: 'P2', roomCode: created.room.code, clientId: bId });
  assert.equal(again.ok, true);
  assert.equal(again.playerId, joined.playerId);
  const stranger = await emit(client(), 'joinRoom', { name: 'P3', roomCode: created.room.code, clientId: cid('c') });
  assert.equal(stranger.ok, false, 'new players still cannot join a running game');
});

test('turns: only the current player can call a number from their card', async () => {
  const a = client();
  const b = client();
  const aCard = once(a, 'player:card');
  const bCard = once(b, 'player:card');
  const created = await emit(a, 'createRoom', { name: 'T1', clientId: cid('a') });
  const joined = await emit(b, 'joinRoom', { name: 'T2', roomCode: created.room.code, clientId: cid('b') });
  await aCard;
  await bCard;
  const cards = {};
  a.on('player:card', (c) => (cards.a = c));
  b.on('player:card', (c) => (cards.b = c));
  const started = new Promise((resolve) => a.on('room:update', (r) => r.status === 'running' && resolve(r)));
  await emit(a, 'startGame', { roomCode: created.room.code });
  const room = await started;
  await wait(30);
  const aTurn = room.currentPlayerId === created.playerId;
  const [mover, other, moverCard] = aTurn ? [a, b, cards.a] : [b, a, cards.b];
  assert.equal((await emit(other, 'callSpecificNumber', { roomCode: room.code, number: moverCard[0] })).ok, false);
  assert.equal((await emit(mover, 'callSpecificNumber', { roomCode: room.code, number: moverCard[0] })).ok, true);
  void joined;
});

test('host can remove a player by public id', async () => {
  const a = client();
  const b = client();
  const created = await emit(a, 'createRoom', { name: 'Boss', clientId: cid('a') });
  const joined = await emit(b, 'joinRoom', { name: 'Noisy', roomCode: created.room.code, clientId: cid('b') });
  const kicked = once(b, 'player:kicked');
  assert.equal((await emit(a, 'removePlayer', { roomCode: created.room.code, targetId: joined.playerId })).ok, true);
  await kicked;
  // Non-hosts cannot remove anyone.
  const c = client();
  const third = await emit(c, 'joinRoom', { name: 'Calm', roomCode: created.room.code, clientId: cid('c') });
  assert.equal(third.ok, true);
  assert.equal((await emit(c, 'removePlayer', { roomCode: created.room.code, targetId: created.playerId })).ok, false);
});

test('leaving a room removes you immediately', async () => {
  const a = client();
  const b = client();
  const created = await emit(a, 'createRoom', { name: 'L1', clientId: cid('a') });
  await emit(b, 'joinRoom', { name: 'L2', roomCode: created.room.code, clientId: cid('b') });
  const update = new Promise((resolve) => a.on('room:update', (r) => r.players.length === 1 && resolve(r)));
  await emit(b, 'leaveRoom');
  await update;
});

test('play with computer: game starts at once and runs to the end', async () => {
  const a = client();
  let card = [];
  const called = new Set();
  a.on('player:card', (c) => (card = c));
  let room;
  a.on('room:update', (r) => (room = r));
  a.on('number:called', (n) => {
    called.add(n);
    // Mark like the browser does.
    a.emit('updateMarkedNumbers', { roomCode: room?.code, markedNumbers: card.filter((x) => called.has(x)) });
  });
  const res = await emit(a, 'playComputer', { name: 'Solo', clientId: cid('solo'), bots: 2, difficulty: 'hard' });
  assert.equal(res.ok, true);
  assert.equal(res.room.vsComputer, true);
  assert.equal(res.room.status, 'running');
  assert.equal(res.room.players.length, 3);
  assert.equal(res.room.players.filter((p) => p.isBot).length, 2);
  room = res.room;

  // Play our turns until the game ends; bots play theirs on the server.
  const deadline = Date.now() + 8000;
  while (room.status === 'running' && Date.now() < deadline) {
    if (room.currentPlayerId === res.playerId) {
      const pick = card.find((n) => !room.calledNumbers.includes(n));
      if (pick != null) await emit(a, 'callSpecificNumber', { roomCode: room.code, number: pick });
    }
    await wait(10);
  }
  assert.equal(room.status, 'ended', 'game should finish');
  assert.ok(room.winners.length >= 1);
  const botCalls = room.calledNumbers.length;
  assert.ok(botCalls > 5, 'both sides called numbers');
});

test('computer rooms cannot be joined and close when the person leaves', async () => {
  const a = client();
  const res = await emit(a, 'playComputer', { name: 'Alone', clientId: cid('al'), bots: 1, difficulty: 'easy' });
  const join = await emit(client(), 'joinRoom', { name: 'Intruder', roomCode: res.room.code, clientId: cid('in') });
  assert.equal(join.ok, false);
  assert.ok(ROOMS.has(res.room.code));
  await emit(a, 'leaveRoom');
  assert.equal(ROOMS.has(res.room.code), false);
});

test('hard computer always finishes a line when it can', () => {
  const size = 5;
  const card = Array.from({ length: 25 }, (_, i) => i + 1);
  const bot = {
    card,
    positions: new Map(card.map((n, i) => [n, i])),
    marked: new Set([1, 2, 3, 4, 7, 13]), // top row needs 5
    completedLines: new Set(),
  };
  const room = { calledNumbers: [1, 2, 3, 4, 7, 13], boardSize: size, botLevel: 'hard', winPatterns: buildWinPatterns(size) };
  for (let i = 0; i < 20; i++) assert.equal(chooseBotNumber(room, bot), 5);
  room.botLevel = 'easy';
  assert.ok(!room.calledNumbers.includes(chooseBotNumber(room, bot)));
});

test('win patterns and helpers', () => {
  assert.equal(buildWinPatterns(5).length, 12);
  assert.equal(buildWinPatterns(10).length, 22);
  assert.equal(normalizeCode(' abcd '), 'ABCD');
  assert.equal(sanitizeClientId('bad id!'), null);
  assert.ok(sanitizeClientId('good-client-id-123'));
});

// Regression: two players finishing on the same call used to be decided by
// whichever browser reported its marks first. Now both finish together.
test('players who finish on the same call share the place (1 v 1 is a draw)', () => {
  const { callNumber, createPlayer, bootstrapRoom } = require('../server/index');
  const room = bootstrapRoom('TIE1', 'p1');
  room.status = 'running';
  const a = createPlayer('p1', 'Ann', 5);
  const b = createPlayer('p2', 'Ben', 5);
  // Same card for both, so every call completes the same lines for both.
  const card = Array.from({ length: 25 }, (_, i) => i + 1);
  for (const p of [a, b]) {
    p.card = card;
    p.positions = new Map(card.map((n, i) => [n, i]));
    room.players.set(p.id, p);
  }
  room.playerOrder = ['p1', 'p2'];
  ROOMS.set(room.code, room);
  // Rows 1-4 complete: 4 points each, one short of winning.
  for (let n = 1; n <= 20; n++) callNumber(room, n);
  assert.equal(room.status, 'running');
  assert.equal(a.points, b.points);
  assert.equal(a.points, 4);
  callNumber(room, 21); // finishes a column (and a diagonal) on both cards at once
  assert.equal(room.status, 'ended');
  assert.equal(room.winners.length, 2);
  assert.deepEqual(room.winners.map((w) => w.rank), [1, 1]);
  assert.equal(room.draw, true);
  assert.equal(room.loser, null);
  ROOMS.delete(room.code);
});

test('marks sent by a browser can no longer score points', async () => {
  const a = client();
  const b = client();
  const created = await emit(a, 'createRoom', { name: 'Cheat', clientId: cid('a') });
  await emit(b, 'joinRoom', { name: 'Fair', roomCode: created.room.code, clientId: cid('b') });
  await emit(a, 'startGame', { roomCode: created.room.code });
  a.emit('updateMarkedNumbers', { roomCode: created.room.code, markedNumbers: Array.from({ length: 25 }, (_, i) => i + 1) });
  await wait(50);
  const room = ROOMS.get(created.room.code);
  assert.ok([...room.players.values()].every((p) => p.points === 0 && p.marked.size === 0));
});
