const test = require('node:test');
const assert = require('node:assert/strict');
process.env.RECONNECT_GRACE_MS = '300';
const { io: connect } = require('socket.io-client');
const { httpServer, io, buildWinPatterns, normalizeCode, sanitizeClientId } = require('../server/index');

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

test('win patterns and helpers', () => {
  assert.equal(buildWinPatterns(5).length, 12);
  assert.equal(buildWinPatterns(10).length, 22);
  assert.equal(normalizeCode(' abcd '), 'ABCD');
  assert.equal(sanitizeClientId('bad id!'), null);
  assert.ok(sanitizeClientId('good-client-id-123'));
});
