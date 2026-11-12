'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../lib/rules');
const E = require('../lib/room');
const { generateSyntheticPlayers } = require('../lib/data');

// ───────────────────────────────────────────── helpers
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWorld(seed = 7) {
  const players = generateSyntheticPlayers(2026);
  const rng = seeded(seed);
  const ctx = { now: 1_000_000, rng, players: Object.fromEntries(players.map((p) => [p.id, p])), playerIds: players.map((p) => p.id) };
  const room = E.newRoom('TEST01', 'Alice', 'tok-a', ctx.now);
  E.joinRoom(room, 'Bob', 'tok-b', ctx.now);
  E.setConnected(room, 0, true, ctx.now);
  E.setConnected(room, 1, true, ctx.now);
  return { room, ctx, rng, players };
}

function startWithTeams(w) {
  E.applyAction(w.room, 0, { type: 'start' }, w.ctx);
  E.applyAction(w.room, 0, { type: 'pickTeam', teamId: 'CSK' }, w.ctx);
  E.applyAction(w.room, 1, { type: 'pickTeam', teamId: 'MI' }, w.ctx);
  assert.equal(w.room.phase, 'auction');
}

const minNext = (w) => {
  const lot = w.room.auction.lot;
  return lot.highSeat === null ? w.ctx.players[lot.playerId].basePrice : lot.highBid + R.bidIncrement(lot.highBid);
};

/** Auction with a random mix of bids and passes until the phase leaves 'auction'. */
function runAuction(w, bidChance = 0.5) {
  let guard = 0;
  while (w.room.phase === 'auction' && guard++ < 20000) {
    w.ctx.now += 1000;
    for (const seat of [0, 1]) {
      if (w.room.phase !== 'auction') break;
      if (!w.room.auction.lot) { E.tick(w.room, w.ctx); continue; }
      // A reasonable (not omniscient) bot: bids more eagerly while its squad is short.
      const short = w.room.squads[seat].length < R.SQUAD_RULES.min;
      const chance = short ? Math.min(0.9, bidChance + 0.4) : bidChance;
      const action = w.rng() < chance ? { type: 'bid', amount: minNext(w) } : { type: 'pass' };
      try { E.applyAction(w.room, seat, action, w.ctx); } catch { /* rejected by rules: expected */ }
    }
    E.tick(w.room, w.ctx);
  }
}


/** Runs the auction, restarting it (as the host may) until both squads are valid. */
function reachValidSquads(w, bidChance = 0.45) {
  for (let attempt = 0; attempt < 15; attempt++) {
    runAuction(w, bidChance);
    assert.equal(w.room.phase, 'squad');
    const valid = w.room.squads.every((sq) => R.validateSquad(sq.map((s) => w.ctx.players[s.playerId])).valid);
    if (valid) return;
    E.applyAction(w.room, 0, { type: 'restartAuction' }, w.ctx);
  }
  throw new Error('could not reach valid squads in 15 attempts');
}

const readyBoth = (w) => {
  E.applyAction(w.room, 0, { type: 'readySquad' }, w.ctx);
  E.applyAction(w.room, 1, { type: 'readySquad' }, w.ctx);
};

/** Plays every round of every match, locking random legal categories. */
function playTournament(w) {
  let guard = 0;
  while (w.room.phase !== 'champion' && guard++ < 200000) {
    w.ctx.now += 500;
    const r = w.room.round;
    if (r && r.stage === 'selecting') {
      for (const seat of [0, 1]) {
        if (r.selections[seat]) continue;
        const opts = R.availableCategories(w.ctx.players[r.cards[seat]]);
        E.applyAction(w.room, seat, { type: 'lock', category: opts[Math.floor(w.rng() * opts.length)] }, w.ctx);
      }
    }
    E.tick(w.room, w.ctx);
  }
}

// ───────────────────────────────────────────── rules
test('normalise: higher-is-better and lower-is-better directions', () => {
  assert.equal(R.normalize('runs', 8000), 100);
  assert.equal(R.normalize('runs', 0), 0);
  assert.equal(R.normalize('runs', 4000), 50);
  // Bowling average: lower is better (15 is best → 100, 50 is worst → 0)
  assert.equal(R.normalize('bowlingAverage', 15), 100);
  assert.equal(R.normalize('bowlingAverage', 50), 0);
  assert.equal(R.normalize('economyRate', 6), 100);
  assert.equal(R.normalize('economyRate', 9.5) < R.normalize('economyRate', 7), true);
});

test('normalise: clamps out-of-range values and rejects missing stats', () => {
  assert.equal(R.normalize('catches', 9999), 100);
  assert.equal(R.normalize('bowlingAverage', 90), 0);
  assert.throws(() => R.normalize('runs', null), { code: 'MISSING_STAT' });
  assert.throws(() => R.normalize('nope', 1), { code: 'INVALID_CATEGORY' });
});

test('compareRound: equal normalised scores award no point', () => {
  const r = R.compareRound({ category: 'runs', value: 4000 }, { category: 'catches', value: 75 });
  assert.equal(r.scoreA, r.scoreB);
  assert.equal(r.winner, null);
});

test('compareRound: winner is decided on normalised score, not raw value', () => {
  // 150 runs (score ~1.9) vs 3 wickets (score ~1.2): raw 150 > 3 must not decide it alone.
  const r = R.compareRound({ category: 'runs', value: 150 }, { category: 'wickets', value: 3 });
  assert.equal(r.winner, 0);
  const lower = R.compareRound({ category: 'bowlingAverage', value: 18 }, { category: 'bowlingAverage', value: 30 });
  assert.equal(lower.winner, 0, 'lower bowling average wins');
});

test('availableCategories respects role and prerequisite stats', () => {
  const players = generateSyntheticPlayers(2026);
  const batter = players.find((p) => p.role === 'Batter');
  const bowler = players.find((p) => p.role === 'Bowler');
  assert.equal(R.availableCategories(batter).includes('wickets'), false);
  assert.equal(R.availableCategories(batter).includes('bowlingAverage'), false);
  assert.equal(R.availableCategories(bowler).includes('battingAverage'), false, 'no batting average without a batting record');
  assert.equal(R.availableCategories(bowler).includes('bowlingAverage'), true);
  const zeroWkts = { ...batter, stats: { ...batter.stats, wickets: 0, bowlingAverage: 25 } };
  assert.equal(R.availableCategories(zeroWkts).includes('bowlingAverage'), false, 'zero wickets blocks bowling average');
});

test('validateSquad enforces size and role minimums', () => {
  const players = generateSyntheticPlayers(2026);
  const bat = players.filter((p) => p.role === 'Batter');
  const bowl = players.filter((p) => p.role === 'Bowler');
  const wk = players.filter((p) => p.role === 'Wicketkeeper');
  const ar = players.filter((p) => p.role === 'All-rounder');
  const good = [...bat.slice(0, 4), ...bowl.slice(0, 4), ...wk.slice(0, 1), ...ar.slice(0, 6)];
  assert.equal(R.validateSquad(good).valid, true);
  assert.equal(R.validateSquad(good.slice(0, 10)).valid, false);
  const noKeeper = good.filter((p) => p.role !== 'Wicketkeeper').concat(ar.slice(6, 7));
  assert.match(R.validateSquad(noKeeper).problems.join(' '), /wicketkeeper/);
});

// ───────────────────────────────────────────── lobby & teams
test('start requires both players connected and a second seat', () => {
  const players = generateSyntheticPlayers(2026);
  const ctx = { now: 0, rng: Math.random, players: Object.fromEntries(players.map((p) => [p.id, p])), playerIds: players.map((p) => p.id) };
  const room = E.newRoom('ABC123', 'Host', 't1', 0);
  assert.throws(() => E.applyAction(room, 0, { type: 'start' }, ctx), { code: 'WAITING' });
  E.joinRoom(room, 'Guest', 't2', 0);
  E.setConnected(room, 0, true, 0);
  assert.throws(() => E.applyAction(room, 0, { type: 'start' }, ctx), { code: 'NOT_CONNECTED' });
  E.setConnected(room, 1, true, 0);
  E.applyAction(room, 0, { type: 'start' }, ctx);
  assert.equal(room.phase, 'teams');
});

test('only the host can start; a third player cannot join', () => {
  const w = makeWorld();
  w.room.phase = 'lobby';
  assert.throws(() => E.applyAction(w.room, 1, { type: 'start' }, w.ctx), { code: 'HOST_ONLY' });
  assert.throws(() => E.joinRoom(w.room, 'Eve', 'tok-e', 0), { code: 'ROOM_FULL' });
});

test('two players cannot pick the same franchise', () => {
  const w = makeWorld();
  E.applyAction(w.room, 0, { type: 'start' }, w.ctx);
  E.applyAction(w.room, 0, { type: 'pickTeam', teamId: 'GT' }, w.ctx);
  assert.throws(() => E.applyAction(w.room, 1, { type: 'pickTeam', teamId: 'GT' }, w.ctx), { code: 'TEAM_TAKEN' });
  assert.throws(() => E.applyAction(w.room, 1, { type: 'pickTeam', teamId: 'XXX' }, w.ctx), { code: 'INVALID_TEAM' });
});

// ───────────────────────────────────────────── auction
test('bids must meet the base price and the minimum increment', () => {
  const w = makeWorld();
  startWithTeams(w);
  const lot = w.room.auction.lot;
  const base = w.ctx.players[lot.playerId].basePrice;
  assert.throws(() => E.applyAction(w.room, 0, { type: 'bid', amount: base - 1 }, w.ctx), { code: 'BID_TOO_LOW' });
  E.applyAction(w.room, 0, { type: 'bid', amount: base }, w.ctx);
  assert.throws(() => E.applyAction(w.room, 0, { type: 'bid', amount: base + 1 }, w.ctx), { code: 'ALREADY_HIGH_BIDDER' });
  assert.throws(() => E.applyAction(w.room, 1, { type: 'bid', amount: base }, w.ctx), { code: 'BID_TOO_LOW' });
  E.applyAction(w.room, 1, { type: 'bid', amount: base + R.bidIncrement(base) }, w.ctx);
  assert.equal(w.room.auction.lot.highSeat, 1);
});

test('no bid may exceed the remaining purse, and reserve is kept for the minimum squad', () => {
  const w = makeWorld();
  startWithTeams(w);
  w.room.purse[0] = 1000; // ₹10 Cr left
  const lot = w.room.auction.lot;
  w.ctx.players[lot.playerId].basePrice = 50;
  assert.throws(() => E.applyAction(w.room, 0, { type: 'bid', amount: 1001 }, w.ctx), { code: 'EXCEEDS_PURSE' });
  // squad needs 15 players, so after this buy 14 remain → reserve 14 × ₹0.5 Cr = 700 lakh
  assert.throws(() => E.applyAction(w.room, 0, { type: 'bid', amount: 400 }, w.ctx), { code: 'PURSE_RESERVE' });
  E.applyAction(w.room, 0, { type: 'bid', amount: 300 }, w.ctx);
});

test('a lot is closed by the other player passing, and sold at the leading bid', () => {
  const w = makeWorld();
  startWithTeams(w);
  const pid = w.room.auction.lot.playerId;
  E.applyAction(w.room, 0, { type: 'bid', amount: w.ctx.players[pid].basePrice }, w.ctx);
  E.applyAction(w.room, 1, { type: 'pass' }, w.ctx);
  assert.equal(w.room.squads[0].length, 1);
  assert.equal(w.room.squads[0][0].playerId, pid);
  assert.equal(w.room.purse[0], R.PURSE - w.ctx.players[pid].basePrice);
  assert.equal(w.room.auction.lastResult.type, 'SOLD');
});

test('highest bidder cannot pass; a passed seat cannot bid again on that lot', () => {
  const w = makeWorld();
  startWithTeams(w);
  E.applyAction(w.room, 0, { type: 'bid', amount: w.ctx.players[w.room.auction.lot.playerId].basePrice }, w.ctx);
  assert.throws(() => E.applyAction(w.room, 0, { type: 'pass' }, w.ctx), { code: 'HIGH_BIDDER_CANNOT_PASS' });
  E.applyAction(w.room, 1, { type: 'pass' }, w.ctx); // closes the lot
  assert.equal(w.room.auction.lot, null);
});

test('bidding timer closes a lot at its deadline; unsold when nobody bids', () => {
  const w = makeWorld();
  startWithTeams(w);
  const pid = w.room.auction.lot.playerId;
  w.ctx.now += E.TIMING.OPEN_MS;
  E.tick(w.room, w.ctx);
  assert.equal(w.room.auction.lastResult.type, 'UNSOLD');
  assert.equal(w.room.auction.lastResult.playerId, pid);
  assert.equal(w.room.squads[0].length + w.room.squads[1].length, 0);
});

test('a player is never sold twice across the auction', () => {
  const w = makeWorld(99);
  startWithTeams(w);
  runAuction(w, 0.6);
  const sold = w.room.squads.flat().map((s) => s.playerId);
  assert.equal(new Set(sold).size, sold.length, 'each player appears at most once');
  for (const sq of w.room.squads) {
    assert.ok(sq.length <= R.SQUAD_RULES.max);
  }
  for (let s = 0; s < 2; s++) {
    const spent = w.room.squads[s].reduce((t, x) => t + x.price, 0);
    assert.equal(R.PURSE - w.room.purse[s], spent, 'purse deduction matches purchases');
    assert.ok(w.room.purse[s] >= 0);
  }
});

// ───────────────────────────────────────────── tournament
test('full game: auction → squads → 14 matches × 11 rounds → champion', () => {
  const w = makeWorld(2026);
  startWithTeams(w);
  reachValidSquads(w);
  // An invalid squad must block progression
  readyBoth(w);
  assert.equal(w.room.phase, 'tournament');
  assert.equal(w.room.matches.length, R.TOTAL_MATCHES);

  playTournament(w);

  assert.equal(w.room.phase, 'champion');
  let expectedPoints = [0, 0];
  for (const m of w.room.matches) {
    assert.equal(m.status, 'done');
    assert.equal(m.rounds.length, R.ROUNDS_PER_MATCH, `match ${m.n} has exactly 11 rounds`);
    assert.ok(m.scores[0] + m.scores[1] <= R.ROUNDS_PER_MATCH, 'at most one point per round');
    for (const seat of [0, 1]) {
      const used = m.rounds.map((rd) => rd.entries[seat].playerId);
      assert.equal(new Set(used).size, used.length, 'no card repeats within a match');
    }
    const expectedWinner = m.scores[0] === m.scores[1] ? null : (m.scores[0] > m.scores[1] ? 0 : 1);
    assert.equal(m.winnerSeat, expectedWinner);
    if (m.winnerSeat === null) { expectedPoints[0] += 1; expectedPoints[1] += 1; }
    else expectedPoints[m.winnerSeat] += 2;
  }
  const st = E.standings(w.room);
  assert.equal(st.complete, true);
  assert.equal(st.rows[0].played, 14);
  assert.equal(st.rows[1].played, 14);
  assert.deepEqual([st.rows[0].points, st.rows[1].points], expectedPoints, 'standings match per-match points');
  assert.equal(st.rows[0].wins + st.rows[0].draws + st.rows[0].losses, 14);
  assert.equal(st.rows[1].wins + st.rows[1].draws + st.rows[1].losses, 14);
  if (!st.jointChampions) assert.equal(st.champion, st.ranking[0]);
});

test('round reveal: each round has exactly one winner or a draw, and the scores are normalised', () => {
  const w = makeWorld(5);
  startWithTeams(w);
  reachValidSquads(w);
  readyBoth(w);
  E.applyAction(w.room, 0, { type: 'lock', category: R.availableCategories(w.ctx.players[w.room.round.cards[0]])[0] }, w.ctx);
  E.applyAction(w.room, 1, { type: 'lock', category: R.availableCategories(w.ctx.players[w.room.round.cards[1]])[0] }, w.ctx);
  assert.equal(w.room.round.stage, 'revealed');
  const rd = w.room.matches[0].rounds[0];
  assert.equal(rd.entries.length, 2);
  for (const e of rd.entries) assert.ok(e.score >= 0 && e.score <= 100);
});

test('locking is one-shot and category must be available for the drawn card', () => {
  const w = makeWorld(11);
  startWithTeams(w);
  reachValidSquads(w);
  readyBoth(w);
  const card = w.ctx.players[w.room.round.cards[0]];
  assert.throws(() => E.applyAction(w.room, 0, { type: 'lock', category: 'nonsense' }, w.ctx), { code: 'INVALID_CATEGORY' });
  const unavailable = Object.keys(R.CATEGORIES).find((k) => !R.availableCategories(card).includes(k));
  if (unavailable) assert.throws(() => E.applyAction(w.room, 0, { type: 'lock', category: unavailable }, w.ctx), { code: 'INVALID_CATEGORY' });
  E.applyAction(w.room, 0, { type: 'lock', category: R.availableCategories(card)[0] }, w.ctx);
  assert.throws(() => E.applyAction(w.room, 0, { type: 'lock', category: R.availableCategories(card)[0] }, w.ctx), { code: 'ALREADY_LOCKED' });
});

// ───────────────────────────────────────────── privacy
test('private view: opponent card and choice are absent until reveal', () => {
  const w = makeWorld(21);
  startWithTeams(w);
  reachValidSquads(w);
  readyBoth(w);

  const oppCard = w.room.round.cards[1];
  const myCard = w.room.round.cards[0];
  const v0 = E.viewFor(w.room, 0, w.ctx);
  assert.equal(v0.round.myCard.id, myCard);
  assert.equal(v0.round.reveal, null);
  const roundJson = JSON.stringify(v0.round);
  assert.equal(roundJson.includes(oppCard), false, 'opponent card id must not be in round payload');
  assert.equal(JSON.stringify(v0.match).includes(oppCard), false);

  E.applyAction(w.room, 0, { type: 'lock', category: R.availableCategories(w.ctx.players[myCard])[0] }, w.ctx);
  const v0b = E.viewFor(w.room, 0, w.ctx);
  assert.equal(v0b.round.opponentStatus, 'selecting', 'opponent has not locked yet, so only that status is shown');
  assert.equal(v0b.round.youChoice, R.availableCategories(w.ctx.players[myCard])[0]);
  assert.equal(JSON.stringify(v0b.round).includes(oppCard), false, 'still no opponent card');
  assert.equal(v0b.round.reveal, null);

  const v1 = E.viewFor(w.room, 1, w.ctx);
  assert.equal(v1.round.youLocked, false, 'opponent sees only their own lock state');
  assert.equal(v1.round.opponentStatus, 'locked');
  assert.equal(JSON.stringify(v1.round).includes(myCard), false, 'player 2 never sees player 1 card pre-reveal');

  E.applyAction(w.room, 1, { type: 'lock', category: R.availableCategories(w.ctx.players[oppCard])[0] }, w.ctx);
  const revealed = E.viewFor(w.room, 0, w.ctx);
  assert.equal(revealed.round.opponentStatus, 'revealed');
  assert.equal(revealed.round.reveal.entries.length, 2);
  assert.ok(revealed.round.reveal.entries.some((e) => e.player.id === oppCard), 'opponent card appears after reveal');
});

test('duplicate actionIds are applied once', () => {
  const w = makeWorld(3);
  E.applyAction(w.room, 0, { type: 'start', actionId: 'a1' }, w.ctx);
  const v = w.room.version;
  const again = E.applyAction(w.room, 0, { type: 'start', actionId: 'a1' }, w.ctx);
  assert.equal(again.duplicate, true);
  assert.equal(w.room.version, v, 'state unchanged by the duplicate');
});

test('timers auto-lock a missing selection at the deadline', () => {
  const w = makeWorld(31);
  startWithTeams(w);
  reachValidSquads(w);
  readyBoth(w);
  E.applyAction(w.room, 0, { type: 'lock', category: R.availableCategories(w.ctx.players[w.room.round.cards[0]])[0] }, w.ctx);
  w.ctx.now += E.TIMING.SELECT_MS;
  E.tick(w.room, w.ctx);
  assert.equal(w.room.round.stage, 'revealed');
  assert.equal(w.room.matches[0].rounds[0].entries[1].auto, true);
});
