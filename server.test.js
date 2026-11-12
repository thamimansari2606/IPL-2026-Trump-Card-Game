'use strict';
/**
 * End-to-end tests over real HTTP + SSE with two independent clients (separate
 * tokens, separate streams), exactly as two browsers would talk to the server.
 *
 * Setup shortcut: to reach the tournament quickly, the test writes valid squads
 * straight into the server's in-memory room. Everything after that (locks, reveals,
 * privacy, reconnection) goes through the public HTTP/SSE API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server');
const { generateSyntheticPlayers } = require('../lib/data');
const R = require('../lib/rules');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipl-trump-test-'));
  return { dir, file: path.join(dir, 'rooms.json') };
}

async function start(storeFile) {
  const srv = createServer({ storeFile, tickMs: 50, players: { players: generateSyntheticPlayers(2026), source: 'test' } });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const streams = [];
  return {
    ...srv,
    base,
    async post(p, body) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    async open(code, token) {
      const s = await sseClient(`${base}/api/rooms/${code}/stream?token=${token}`);
      streams.push(s);
      return s;
    },
    async close() {
      streams.forEach((s) => s.close());
      srv.server.closeAllConnections();
      await new Promise((resolve) => srv.server.close(resolve));
    },
  };
}

/** Minimal SSE reader that keeps every decoded `state` view in order. */
async function sseClient(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200, `stream opened (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const views = [];
  let buf = '';
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) views.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* closed */ }
    closed = true;
  })();
  return {
    views,
    latest: () => views[views.length - 1],
    async waitFor(pred, ms = 3000, from = 0) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const v = views.slice(from).find(pred);
        if (v) return v;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('timed out waiting for expected view');
    },
    close: () => { closed = true; reader.cancel().catch(() => {}); },
    get closed() { return closed; },
  };
}

/** Puts both players into a valid squad and returns their seat-0/seat-1 squads (test setup only). */
function seedValidSquads(srv, room) {
  const byRole = (role) => Object.values(srv.playersById).filter((p) => p.role === role);
  const take = (role, n, used) => byRole(role).filter((p) => !used.has(p.id)).slice(0, n).map((p) => { used.add(p.id); return p; });
  const used = new Set();
  const squads = [[], []];
  for (const seat of [0, 1]) {
    squads[seat] = [
      ...take('Batter', 5, used), ...take('Bowler', 5, used),
      ...take('All-rounder', 4, used), ...take('Wicketkeeper', 1, used),
    ];
  }
  room.squads = squads.map((list) => list.map((p) => ({ playerId: p.id, price: 0 })));
  room.purse = [R.PURSE, R.PURSE];
  room.phase = 'squad';
  room.squadReady = [false, false];
  room.auction = { queue: [], index: 0, lot: null, lastResult: null, resultSeq: 0, nextLotAt: 0, sold: [], unsold: [], cycles: 0, finished: true };
  room.version++;
  return squads;
}

test('HTTP: create, join by code, both connected, team exclusivity', async () => {
  const { dir, file } = tmpStore();
  const t = await start(file);
  try {
    const health = await fetch(`${t.base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const host = await t.post('/api/rooms', { name: 'Alice' });
    assert.equal(host.status, 200);
    assert.match(host.body.code, /^[A-Z2-9]{6}$/);

    const guest = await t.post('/api/rooms/join', { code: host.body.code.toLowerCase(), name: 'Bob' });
    assert.equal(guest.status, 200);
    assert.equal(guest.body.seat, 1);

    const hostStream = await t.open(host.body.code, host.body.token);
    const guestStream = await t.open(host.body.code, guest.body.token);
    const lobby = await hostStream.waitFor((v) => v.you.seat === 0 && v.opponent && v.opponent.connected === true);
    assert.equal(lobby.phase, 'lobby');
    assert.equal(lobby.opponent.name, 'Bob');
    assert.equal(lobby.lobby.canStart, true);

    assert.equal((await t.post(`/api/rooms/${host.body.code}/action`, { token: host.body.token, type: 'start' })).status, 200);
    assert.equal((await t.post(`/api/rooms/${host.body.code}/action`, { token: host.body.token, type: 'pickTeam', teamId: 'RCB' })).status, 200);
    const clash = await t.post(`/api/rooms/${host.body.code}/action`, { token: guest.body.token, type: 'pickTeam', teamId: 'RCB' });
    assert.equal(clash.status, 400);
    assert.equal(clash.body.error.code, 'TEAM_TAKEN');
    await guestStream.waitFor((v) => v.phase === 'teams');
    assert.equal((await t.post(`/api/rooms/${host.body.code}/action`, { token: guest.body.token, type: 'pickTeam', teamId: 'LSG' })).status, 200);
    const auctionView = await guestStream.waitFor((v) => v.phase === 'auction');
    assert.equal(auctionView.you.teamId, 'LSG');
    assert.equal(auctionView.opponent.teamId, 'RCB');
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: unauthorised tokens cannot read streams or act; unknown rooms 404', async () => {
  const { dir, file } = tmpStore();
  const t = await start(file);
  try {
    const host = await t.post('/api/rooms', { name: 'Alice' });
    const stream = await fetch(`${t.base}/api/rooms/${host.body.code}/stream?token=forged`);
    assert.equal(stream.status, 403);
    const act = await t.post(`/api/rooms/${host.body.code}/action`, { token: 'forged', type: 'start' });
    assert.equal(act.status, 403);
    const missing = await fetch(`${t.base}/api/rooms/ZZZZZ2/stream?token=x`);
    assert.equal(missing.status, 404);
    const full = await t.post('/api/rooms/join', { code: host.body.code, name: 'B' });
    assert.equal(full.status, 200);
    const third = await t.post('/api/rooms/join', { code: host.body.code, name: 'C' });
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'ROOM_FULL');
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: opponent cards and choices never reach the other browser before reveal', async () => {
  const { dir, file } = tmpStore();
  const t = await start(file);
  try {
    const host = await t.post('/api/rooms', { name: 'Alice' });
    const guest = await t.post('/api/rooms/join', { code: host.body.code, name: 'Bob' });
    const code = host.body.code;
    const s0 = await t.open(code, host.body.token);
    const s1 = await t.open(code, guest.body.token);
    await s0.waitFor((v) => v.opponent && v.opponent.connected);

    const room = t.rooms.get(code);
    seedValidSquads(t, room);
    for (const who of [host, guest]) {
      const r = await t.post(`/api/rooms/${code}/action`, { token: who.body.token, type: 'readySquad' });
      assert.equal(r.status, 200);
    }
    await s0.waitFor((v) => v.phase === 'tournament' && v.round);
    const v0 = s0.latest();
    const v1 = await s1.waitFor((v) => v.phase === 'tournament' && v.round);

    const myCard = v0.round.myCard.id;
    const oppCard = v1.round.myCard.id;
    assert.notEqual(myCard, oppCard);

    // Each stream's round payload must only ever contain its own card.
    assert.equal(JSON.stringify(v0.round).includes(oppCard), false, 'player 1 never receives player 2 card pre-reveal');
    assert.equal(JSON.stringify(v1.round).includes(myCard), false, 'player 2 never receives player 1 card pre-reveal');
    assert.equal(v0.round.reveal, null);
    assert.equal(v1.round.reveal, null);

    // Player 1 locks; player 2 must learn only "locked", never the category or card.
    const myChoice = R.availableCategories(t.playersById[myCard])[0];
    const lock0 = await t.post(`/api/rooms/${code}/action`, { token: host.body.token, type: 'lock', category: myChoice });
    assert.equal(lock0.status, 200);
    const afterLock = await s1.waitFor((v) => v.round && v.round.opponentStatus === 'locked');
    assert.equal(JSON.stringify(afterLock.round).includes(myCard), false);
    assert.equal(afterLock.round.reveal, null, 'no reveal while one side is still choosing');
    assert.equal(afterLock.round.youLocked, false);
    assert.equal(afterLock.round.youChoice, null, 'player 2 has no choice recorded yet');

    // Duplicate action id is idempotent over HTTP as well.
    const dupId = 'dup-' + Date.now();
    const oppChoice = R.availableCategories(t.playersById[oppCard])[0];
    const p2 = await t.post(`/api/rooms/${code}/action`, { token: guest.body.token, type: 'lock', category: oppChoice, actionId: dupId });
    const p2again = await t.post(`/api/rooms/${code}/action`, { token: guest.body.token, type: 'lock', category: oppChoice, actionId: dupId });
    assert.equal(p2.status, 200);
    assert.equal(p2again.body.duplicate, true);

    // Both locked → reveal: both streams now show both cards and choices.
    const reveal0 = await s0.waitFor((v) => v.round && v.round.reveal);
    const reveal1 = await s1.waitFor((v) => v.round && v.round.reveal);
    for (const v of [reveal0, reveal1]) {
      const ids = v.round.reveal.entries.map((e) => e.player.id).sort();
      assert.deepEqual(ids, [myCard, oppCard].sort());
      assert.ok([0, 1, null].includes(v.round.reveal.winnerSeat));
      assert.ok(v.round.reveal.entries.every((e) => e.score >= 0 && e.score <= 100));
    }
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnection: state survives a server restart and a dropped stream', async () => {
  const { dir, file } = tmpStore();
  let t = await start(file);
  try {
    const host = await t.post('/api/rooms', { name: 'Alice' });
    const guest = await t.post('/api/rooms/join', { code: host.body.code, name: 'Bob' });
    const code = host.body.code;
    const hostStream = await t.open(code, host.body.token);
    const guestStream = await t.open(code, guest.body.token);
    await hostStream.waitFor((v) => v.opponent && v.opponent.connected);
    await guestStream.waitFor((v) => v.opponent && v.opponent.connected);

    assert.equal((await t.post(`/api/rooms/${code}/action`, { token: host.body.token, type: 'start' })).status, 200);
    await t.post(`/api/rooms/${code}/action`, { token: host.body.token, type: 'pickTeam', teamId: 'GT' });
    await t.post(`/api/rooms/${code}/action`, { token: guest.body.token, type: 'pickTeam', teamId: 'DC' });
    await guestStream.waitFor((v) => v.phase === 'auction');

    // Guest's browser drops its connection: the host sees them go offline…
    const mark = hostStream.views.length;
    guestStream.close();
    const offline = await hostStream.waitFor((v) => v.opponent && v.opponent.connected === false, 3000, mark);
    assert.equal(offline.phase, 'auction', 'a dropped connection does not end the game');
  } finally {
    await t.close();
  }

  // …and a brand-new server process loads the persisted room from disk.
  t = await start(file);
  try {
    const hostAgain = (await fetch(`${t.base}/api/health`).then((r) => r.json())).rooms;
    assert.equal(hostAgain, 1, 'room persisted to disk');
    const code = [...t.rooms.keys()][0];
    const guest = t.rooms.get(code).seats[1].token;
    const back = await t.open(code, guest);
    const v = await back.waitFor((x) => x.phase === 'auction');
    assert.equal(v.you.teamId, 'DC');
    assert.equal(v.opponent.teamId, 'GT');
    assert.equal(v.auction.purse[0], R.PURSE);
    assert.equal(v.auction.purse[1], R.PURSE);
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
