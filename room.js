'use strict';
/**
 * Authoritative room / game state machine.
 *
 *   lobby → teams → auction → squad → tournament → champion
 *
 * Every mutation goes through applyAction() or tick(). All validation happens here,
 * on the server. Clients only ever receive viewFor(room, seat), which is the
 * per-player projection: an opponent's private round card and category choice never
 * appear in it until the reveal stage.
 *
 * Functions take an explicit `ctx` ({ now, rng, players, playerIds }) so the engine
 * is deterministic under test.
 */
const R = require('./rules');
const { TEAMS, TEAM_BY_ID } = require('./data');

const TIMING = Object.freeze({
  OPEN_MS: 12000,        // bidding window before the first bid on a lot
  BID_MS: 8000,          // countdown reset after each bid
  RESULT_MS: 3500,       // SOLD / UNSOLD banner before next lot
  SELECT_MS: 30000,      // time to lock a category; auto-picks on expiry
  REVEAL_MS: 5000,       // round result shown before next round
  MATCH_MS: 6000,        // match result shown before next match
});

class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const fail = (code, message) => { throw new GameError(code, message); };

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

// ─────────────────────────────────────────────────────────────── lifecycle

function newRoom(code, hostName, token, now) {
  return {
    code,
    version: 1,
    createdAt: now,
    phase: 'lobby',
    seats: [{ name: hostName, token, connected: false, lastSeen: now, teamId: null }, null],
    purse: [R.PURSE, R.PURSE],
    squads: [[], []],            // [{ playerId, price }]
    squadReady: [false, false],
    auction: null,
    matches: null,
    matchIndex: 0,
    usedCards: [[], []],
    round: null,
    matchResultAt: null,
    processed: [],               // recent actionIds for duplicate suppression
  };
}

/** Seats a joiner, or re-attaches a returning player by token. Returns seat index. */
function joinRoom(room, name, token, now) {
  const existing = room.seats.findIndex((s) => s && s.token === token);
  if (existing !== -1) return existing;
  if (room.phase !== 'lobby') fail('GAME_STARTED', 'This room has already started. Only returning players can rejoin.');
  if (room.seats[1]) fail('ROOM_FULL', 'This room already has two players.');
  room.seats[1] = { name, token, connected: false, lastSeen: now, teamId: null };
  room.version++;
  return 1;
}

function seatForToken(room, token) {
  if (typeof token !== 'string' || !token) return -1;
  return room.seats.findIndex((s) => s && s.token === token);
}

function setConnected(room, seat, connected, now) {
  const s = room.seats[seat];
  if (!s) return;
  s.connected = connected;
  s.lastSeen = now;
  room.version++;
}

// ─────────────────────────────────────────────────────────────── auction

function startAuction(room, ctx) {
  room.phase = 'auction';
  room.auction = {
    queue: shuffle(ctx.playerIds, ctx.rng),
    index: 0,
    lot: null,
    lastResult: null,
    resultSeq: 0,
    nextLotAt: ctx.now,
    sold: [],
    unsold: [],
    cycles: 0,             // re-offer rounds for unsold players
    finished: false,
  };
  startNextLot(room, ctx);
}

const MAX_CYCLES = 10;

/** Players still needed to make a legal squad: size shortfall or role shortfall, whichever is larger. */
function neededSlots(squadPlayerIds, ctx) {
  const players = squadPlayerIds.map((id) => ctx.players[id]);
  const sizeShort = Math.max(0, R.SQUAD_RULES.min - players.length);
  const roleShort = [
    ['Batter', R.SQUAD_RULES.minBatters],
    ['Bowler', R.SQUAD_RULES.minBowlers],
    ['Wicketkeeper', R.SQUAD_RULES.minWicketkeepers],
  ].reduce((t, [role, min]) => t + Math.max(0, min - players.filter((p) => p.role === role).length), 0);
  return Math.max(sizeShort, roleShort);
}

const bothFull = (room) => room.squads.every((sq) => sq.length >= R.SQUAD_RULES.max);
const someBelowMin = (room) => room.squads.some((sq) => sq.length < R.SQUAD_RULES.min);

function startNextLot(room, ctx) {
  const a = room.auction;
  a.lot = null;
  if (bothFull(room)) return endAuction(room);
  if (a.index >= a.queue.length) {
    // Unsold players are re-offered (at base price) while a squad is still short,
    // so a pass-heavy start cannot strand a player with an unbuildable squad.
    if (a.unsold.length && someBelowMin(room) && a.cycles < MAX_CYCLES) {
      a.cycles++;
      a.queue = a.unsold;
      a.unsold = [];
      a.index = 0;
    } else {
      return endAuction(room);
    }
  }
  const playerId = a.queue[a.index++];
  const passed = [false, false];
  room.squads.forEach((sq, seat) => { if (sq.length >= R.SQUAD_RULES.max) passed[seat] = true; });
  a.lot = { playerId, highBid: 0, highSeat: null, deadline: ctx.now + TIMING.OPEN_MS, passed };
}

function closeLot(room, ctx) {
  const a = room.auction;
  const lot = a.lot;
  if (lot.highSeat === null) {
    a.unsold.push(lot.playerId);
    a.lastResult = { type: 'UNSOLD', playerId: lot.playerId, seat: null, price: 0 };
  } else {
    const s = lot.highSeat;
    room.purse[s] -= lot.highBid;
    room.squads[s].push({ playerId: lot.playerId, price: lot.highBid });
    a.sold.push(lot.playerId);
    a.lastResult = { type: 'SOLD', playerId: lot.playerId, seat: s, price: lot.highBid };
  }
  a.resultSeq++;
  a.lot = null;
  a.nextLotAt = ctx.now + TIMING.RESULT_MS;
}

function endAuction(room) {
  room.auction.finished = true;
  room.auction.lot = null;
  room.phase = 'squad';
  room.squadReady = [false, false];
}

function placeBid(room, seat, amount, ctx) {
  const a = room.auction;
  const lot = a && a.lot;
  if (room.phase !== 'auction' || !lot) fail('NO_LOT_OPEN', 'There is no open lot to bid on.');
  if (!Number.isInteger(amount) || amount <= 0) fail('INVALID_AMOUNT', 'Bid must be a positive whole number of lakh.');
  if (lot.passed[seat]) fail('ALREADY_PASSED', 'You have passed on this player.');
  if (lot.highSeat === seat) fail('ALREADY_HIGH_BIDDER', 'You are already the highest bidder.');
  const squad = room.squads[seat];
  if (squad.length >= R.SQUAD_RULES.max) fail('SQUAD_FULL', `Your squad is full (${R.SQUAD_RULES.max} players).`);

  const player = ctx.players[lot.playerId];
  const minimum = lot.highSeat === null ? player.basePrice : lot.highBid + R.bidIncrement(lot.highBid);
  if (amount < minimum) fail('BID_TOO_LOW', `Minimum bid is ${R.formatLakh(minimum)}.`);

  const purse = room.purse[seat];
  if (amount > purse) fail('EXCEEDS_PURSE', `Bid exceeds your remaining purse of ${R.formatLakh(purse)}.`);
  const stillNeeded = Math.max(0, R.SQUAD_RULES.min - (squad.length + 1));
  const reserve = stillNeeded * R.MIN_RESERVE_PER_PLAYER;
  if (amount > purse - reserve) {
    fail('PURSE_RESERVE', `Keep at least ${R.formatLakh(reserve)} to fill the remaining required squad slots.`);
  }

  lot.highBid = amount;
  lot.highSeat = seat;
  lot.deadline = ctx.now + TIMING.BID_MS;
  maybeCloseOnPass(room, ctx);
}

function passLot(room, seat, ctx) {
  const a = room.auction;
  const lot = a && a.lot;
  if (room.phase !== 'auction' || !lot) fail('NO_LOT_OPEN', 'There is no open lot to pass on.');
  if (lot.highSeat === seat) fail('HIGH_BIDDER_CANNOT_PASS', 'You are the highest bidder; wait for the timer or the other player to pass.');
  if (lot.passed[seat]) fail('ALREADY_PASSED', 'You have already passed on this player.');
  // A short squad must keep bidding while the remaining lots only just cover its shortfall.
  const needed = neededSlots(room.squads[seat].map((s) => s.playerId), ctx);
  const remainingIncludingCurrent = a.queue.length - a.index + 1;
  if (needed > 0 && remainingIncludingCurrent <= needed) {
    fail('MUST_BID', `You must keep bidding: you need ${needed} more players and only ${remainingIncludingCurrent} lots remain.`);
  }
  lot.passed[seat] = true;
  maybeCloseOnPass(room, ctx);
}

/** Closes the lot when the non-leading seat has passed (or nobody bid and both passed). */
function maybeCloseOnPass(room, ctx) {
  const lot = room.auction.lot;
  if (!lot) return;
  const shouldClose = lot.highSeat !== null
    ? lot.passed[1 - lot.highSeat] === true
    : lot.passed[0] && lot.passed[1];
  if (shouldClose) closeLot(room, ctx);
}

// ─────────────────────────────────────────────────────────────── tournament

function startTournament(room, ctx) {
  room.phase = 'tournament';
  room.matches = Array.from({ length: R.TOTAL_MATCHES }, (_, i) => ({
    n: i + 1, status: 'upcoming', rounds: [], scores: [0, 0], winnerSeat: null,
  }));
  room.matchIndex = 0;
  startMatch(room, ctx);
}

function startMatch(room, ctx) {
  room.matches[room.matchIndex].status = 'live';
  room.usedCards = [[], []];
  room.matchResultAt = null;
  startRound(room, ctx);
}

function drawCard(room, seat, ctx) {
  const playable = room.squads[seat]
    .map((s) => s.playerId)
    .filter((id) => R.availableCategories(ctx.players[id]).length > 0);
  let pool = playable.filter((id) => !room.usedCards[seat].includes(id));
  if (!pool.length) { room.usedCards[seat] = []; pool = playable; }
  const chosen = pick(pool, ctx.rng);
  room.usedCards[seat].push(chosen);
  return chosen;
}

function startRound(room, ctx) {
  const m = room.matches[room.matchIndex];
  const cards = [drawCard(room, 0, ctx), drawCard(room, 1, ctx)];
  room.round = {
    roundNo: m.rounds.length + 1,
    cards,                       // PRIVATE until reveal
    selections: [null, null],    // PRIVATE until reveal
    stage: 'selecting',
    deadline: ctx.now + TIMING.SELECT_MS,
    revealAt: null,
    entries: null,
    winnerSeat: null,
  };
}

function lockSelection(room, seat, category, ctx) {
  const r = room.round;
  if (room.phase !== 'tournament' || !r || r.stage !== 'selecting') fail('ROUND_NOT_OPEN', 'No round is currently accepting selections.');
  if (r.selections[seat]) fail('ALREADY_LOCKED', 'You have already locked your selection for this round.');
  const player = ctx.players[r.cards[seat]];
  if (!R.availableCategories(player).includes(category)) {
    fail('INVALID_CATEGORY', `"${category}" is not an available statistic for this player.`);
  }
  r.selections[seat] = { category, auto: false };
  if (r.selections.every(Boolean)) reveal(room, ctx);
}

function reveal(room, ctx) {
  const r = room.round;
  const entries = [0, 1].map((seat) => {
    const playerId = r.cards[seat];
    const category = r.selections[seat].category;
    const value = ctx.players[playerId].stats[category];
    return { seat, playerId, category, value, score: R.normalize(category, value), auto: r.selections[seat].auto };
  });
  const cmp = R.compareRound(
    { category: entries[0].category, value: entries[0].value },
    { category: entries[1].category, value: entries[1].value },
  );
  r.entries = entries.map((e, i) => ({ ...e, score: i === 0 ? cmp.scoreA : cmp.scoreB }));
  r.winnerSeat = cmp.winner;
  r.stage = 'revealed';
  r.revealAt = ctx.now + TIMING.REVEAL_MS;

  const m = room.matches[room.matchIndex];
  m.rounds.push({
    roundNo: r.roundNo,
    entries: r.entries.map(({ seat, playerId, category, value, score, auto }) => ({ seat, playerId, category, value, score, auto })),
    winnerSeat: r.winnerSeat,
  });
  if (r.winnerSeat !== null) m.scores[r.winnerSeat]++;
}

function finishMatch(room, ctx) {
  const m = room.matches[room.matchIndex];
  m.status = 'done';
  m.winnerSeat = m.scores[0] === m.scores[1] ? null : (m.scores[0] > m.scores[1] ? 0 : 1);
  room.round = null;
  room.matchResultAt = ctx.now + TIMING.MATCH_MS;
}

function standings(room) {
  const rows = [0, 1].map((seat) => ({
    seat,
    name: room.seats[seat] ? room.seats[seat].name : '',
    played: 0, wins: 0, draws: 0, losses: 0, points: 0, roundWins: 0,
  }));
  for (const m of room.matches || []) {
    if (m.status !== 'done') continue;
    rows.forEach((row) => { row.played++; row.roundWins += m.scores[row.seat]; });
    if (m.winnerSeat === null) {
      rows.forEach((row) => { row.draws++; row.points += R.POINTS.draw; });
    } else {
      rows[m.winnerSeat].wins++;
      rows[m.winnerSeat].points += R.POINTS.win;
      rows[1 - m.winnerSeat].losses++;
      rows[1 - m.winnerSeat].points += R.POINTS.loss;
    }
  }
  const ranking = [...rows].sort((a, b) =>
    b.points - a.points || b.wins - a.wins || b.roundWins - a.roundWins || a.seat - b.seat);
  const [a, b] = ranking;
  const fullyTied = a.points === b.points && a.wins === b.wins && a.roundWins === b.roundWins;
  const complete = (room.matches || []).length > 0 && room.matches.every((m) => m.status === 'done');
  return {
    rows,
    ranking: ranking.map((r) => r.seat),
    complete,
    champion: complete && !fullyTied ? a.seat : null,
    jointChampions: complete && fullyTied,
    tieBreakRule: 'points → match wins → round wins',
  };
}

// ─────────────────────────────────────────────────────────────── actions

/**
 * Applies a client action on behalf of `seat`. Idempotent per actionId.
 * Throws GameError on invalid actions (state is left unchanged for that action).
 */
function applyAction(room, seat, action, ctx) {
  if (action.actionId && room.processed.includes(action.actionId)) {
    return { ok: true, duplicate: true };
  }
  const me = room.seats[seat];
  if (!me) fail('NOT_SEATED', 'You are not seated in this room.');

  switch (action.type) {
    case 'start': {
      if (seat !== 0) fail('HOST_ONLY', 'Only the host can start the game.');
      if (room.phase !== 'lobby') fail('WRONG_PHASE', 'The game has already started.');
      if (!room.seats[1]) fail('WAITING', 'Waiting for the second player to join.');
      if (!room.seats[0].connected || !room.seats[1].connected) {
        fail('NOT_CONNECTED', 'Both players must be connected before starting.');
      }
      room.phase = 'teams';
      break;
    }
    case 'pickTeam': {
      if (room.phase !== 'teams') fail('WRONG_PHASE', 'Team selection is not open.');
      const team = TEAM_BY_ID[action.teamId];
      if (!team) fail('INVALID_TEAM', 'Unknown team.');
      const other = room.seats[1 - seat];
      if (other && other.teamId === team.id) fail('TEAM_TAKEN', `${team.name} has already been picked by your opponent.`);
      me.teamId = team.id;
      if (room.seats[0].teamId && room.seats[1] && room.seats[1].teamId) startAuction(room, ctx);
      break;
    }
    case 'bid': {
      placeBid(room, seat, Number(action.amount), ctx);
      break;
    }
    case 'pass': {
      passLot(room, seat, ctx);
      break;
    }
    case 'readySquad': {
      if (room.phase !== 'squad') fail('WRONG_PHASE', 'Squads are not being finalised.');
      const check = R.validateSquad(room.squads[seat].map((s) => ctx.players[s.playerId]));
      if (!check.valid) fail('SQUAD_INVALID', check.problems.join('; '));
      room.squadReady[seat] = true;
      if (room.squadReady.every(Boolean)) startTournament(room, ctx);
      break;
    }
    case 'restartAuction': {
      if (seat !== 0) fail('HOST_ONLY', 'Only the host can restart the auction.');
      if (room.phase !== 'squad') fail('WRONG_PHASE', 'The auction can only be restarted from squad review.');
      const invalid = room.squads.some((sq) => !R.validateSquad(sq.map((s) => ctx.players[s.playerId])).valid);
      if (!invalid) fail('NOT_NEEDED', 'Both squads are valid; no restart needed.');
      room.squads = [[], []];
      room.purse = [R.PURSE, R.PURSE];
      room.squadReady = [false, false];
      startAuction(room, ctx);
      break;
    }
    case 'lock': {
      lockSelection(room, seat, action.category, ctx);
      break;
    }
    default:
      fail('UNKNOWN_ACTION', `Unknown action "${action.type}".`);
  }

  if (action.actionId) {
    room.processed.push(action.actionId);
    if (room.processed.length > 500) room.processed.shift();
  }
  room.version++;
  return { ok: true };
}

/** Time-driven transitions: bid timers, result banners, selection timeouts, pacing. */
function tick(room, ctx) {
  let changed = false;
  if (room.phase === 'auction' && room.auction && !room.auction.finished) {
    const a = room.auction;
    if (a.lot && ctx.now >= a.lot.deadline) { closeLot(room, ctx); changed = true; }
    else if (!a.lot && ctx.now >= a.nextLotAt) { startNextLot(room, ctx); changed = true; }
  }
  if (room.phase === 'tournament' && room.round) {
    const r = room.round;
    if (r.stage === 'selecting' && ctx.now >= r.deadline) {
      for (const seat of [0, 1]) {
        if (!r.selections[seat]) {
          const options = R.availableCategories(ctx.players[r.cards[seat]]);
          r.selections[seat] = { category: pick(options, ctx.rng), auto: true };
        }
      }
      reveal(room, ctx);
      changed = true;
    } else if (r.stage === 'revealed' && ctx.now >= r.revealAt) {
      const m = room.matches[room.matchIndex];
      if (m.rounds.length < R.ROUNDS_PER_MATCH) startRound(room, ctx);
      else finishMatch(room, ctx);
      changed = true;
    }
  } else if (room.phase === 'tournament' && !room.round && room.matchResultAt && ctx.now >= room.matchResultAt) {
    room.matchResultAt = null;
    room.matchIndex++;
    if (room.matchIndex >= R.TOTAL_MATCHES) room.phase = 'champion';
    else startMatch(room, ctx);
    changed = true;
  }
  if (changed) room.version++;
  return changed;
}

// ─────────────────────────────────────────────────────────────── views

const pubPlayer = (p) => ({
  id: p.id, name: p.name, role: p.role, nationality: p.nationality,
  basePrice: p.basePrice, iplTeams: p.iplTeams || [], dataSource: p.dataSource,
  photo: p.photo || null, stats: p.stats,
});

const catLabel = (key) => R.CATEGORIES[key].label;

/**
 * Per-player projection. This is the ONLY object sent to a client. Opponent cards
 * and category choices are included only when stage === 'revealed'.
 */
function viewFor(room, seat, ctx) {
  const opp = 1 - seat;
  const me = room.seats[seat];
  const other = room.seats[opp];
  const nameOf = (s) => (room.seats[s] ? room.seats[s].name : '');

  const view = {
    code: room.code,
    version: room.version,
    phase: room.phase,
    serverNow: ctx.now,
    you: { seat, name: me.name, teamId: me.teamId, connected: me.connected },
    opponent: other
      ? { seat: opp, name: other.name, teamId: other.teamId, connected: other.connected }
      : null,
    teams: TEAMS.map((t) => {
      const takenBy = room.seats.findIndex((s) => s && s.teamId === t.id);
      return { ...t, takenBySeat: takenBy === -1 ? null : takenBy };
    }),
    lobby: {
      waiting: !other,
      bothConnected: Boolean(other && me.connected && other.connected),
      canStart: seat === 0 && room.phase === 'lobby' && Boolean(other && me.connected && other.connected),
    },
  };

  if (room.auction) {
    const a = room.auction;
    const lot = a.lot;
    const remaining = a.queue.length - a.index + (lot ? 1 : 0);
    view.auction = {
      startingPurse: R.PURSE,
      purse: room.purse.slice(),
      myPurse: room.purse[seat],
      soldCount: a.sold.length,
      remainingPlayers: Math.max(0, remaining),
      finished: a.finished,
      lot: lot ? {
        player: pubPlayer(ctx.players[lot.playerId]),
        highBid: lot.highBid,
        highSeat: lot.highSeat,
        highName: lot.highSeat === null ? null : nameOf(lot.highSeat),
        minNext: lot.highSeat === null
          ? ctx.players[lot.playerId].basePrice
          : lot.highBid + R.bidIncrement(lot.highBid),
        deadline: lot.deadline,
        passed: lot.passed.slice(),
        youCanBid: !lot.passed[seat] && lot.highSeat !== seat && room.squads[seat].length < R.SQUAD_RULES.max,
        youCanPass: lot.highSeat !== seat && !lot.passed[seat],
      } : null,
      lastResult: a.lastResult ? {
        ...a.lastResult,
        player: { id: a.lastResult.playerId, name: ctx.players[a.lastResult.playerId].name, role: ctx.players[a.lastResult.playerId].role },
        winnerName: a.lastResult.seat === null ? null : nameOf(a.lastResult.seat),
        seq: a.resultSeq,
      } : null,
    };
    view.squads = [0, 1].map((s) => {
      const players = room.squads[s].map((x) => ({ ...pubPlayer(ctx.players[x.playerId]), price: x.price }));
      return {
        seat: s,
        name: nameOf(s),
        teamId: room.seats[s] ? room.seats[s].teamId : null,
        purse: room.purse[s],
        spent: R.PURSE - room.purse[s],
        players,
        validation: R.validateSquad(players),
        ready: room.squadReady[s],
      };
    });
  }

  if (room.phase === 'squad') {
    view.squadPhase = {
      youReady: room.squadReady[seat],
      opponentReady: room.squadReady[opp],
      canRestart: seat === 0 && view.squads.some((sq) => !sq.validation.valid),
      rules: R.SQUAD_RULES,
    };
  }

  if (room.matches) {
    const matchesSummary = room.matches.map((m) => ({
      n: m.n, status: m.status, scores: m.scores.slice(), winnerSeat: m.winnerSeat,
      roundsPlayed: m.rounds.length,
    }));
    view.tournament = {
      totalMatches: R.TOTAL_MATCHES,
      currentMatch: Math.min(room.matchIndex + 1, R.TOTAL_MATCHES),
      matches: matchesSummary,
      // Revealed rounds are public history; the current round is added below only once revealed.
      history: room.matches.map((m) => ({
        n: m.n,
        status: m.status,
        winnerSeat: m.winnerSeat,
        scores: m.scores.slice(),
        rounds: m.rounds.map((rd) => ({
          roundNo: rd.roundNo,
          winnerSeat: rd.winnerSeat,
          entries: rd.entries.map((e) => ({
            seat: e.seat, name: nameOf(e.seat), player: pubPlayer(ctx.players[e.playerId]),
            category: e.category, label: catLabel(e.category), value: e.value, score: e.score,
            auto: e.auto,
          })),
        })),
      })),
      standings: standings(room),
    };
  }

  if (room.phase === 'tournament' && room.round) {
    const r = room.round;
    const m = room.matches[room.matchIndex];
    const scoreboard = {
      n: m.n,
      totalRounds: R.ROUNDS_PER_MATCH,
      roundNo: r.roundNo,
      roundsPlayed: m.rounds.length,
      roundsRemaining: R.ROUNDS_PER_MATCH - m.rounds.length,
      scores: m.scores.slice(),
      names: [nameOf(0), nameOf(1)],
    };
    const round = {
      stage: r.stage,
      deadline: r.stage === 'selecting' ? r.deadline : null,
      revealAt: r.stage === 'revealed' ? r.revealAt : null,
      youLocked: Boolean(r.selections[seat]),
      youChoice: r.selections[seat] ? r.selections[seat].category : null,
      opponentStatus: r.stage === 'revealed' ? 'revealed' : (r.selections[opp] ? 'locked' : 'selecting'),
      myCard: null,
      reveal: null,
    };
    if (r.stage === 'selecting') {
      const p = ctx.players[r.cards[seat]];
      round.myCard = {
        ...pubPlayer(p),
        options: R.availableCategories(p).map((k) => ({ key: k, label: catLabel(k), group: R.CATEGORIES[k].group, value: p.stats[k] })),
      };
    }
    if (r.stage === 'revealed') {
      round.reveal = {
        winnerSeat: r.winnerSeat,
        winnerName: r.winnerSeat === null ? null : nameOf(r.winnerSeat),
        entries: r.entries.map((e) => ({
          seat: e.seat, name: nameOf(e.seat), player: pubPlayer(ctx.players[e.playerId]),
          category: e.category, label: catLabel(e.category), value: e.value, score: e.score, auto: e.auto,
        })),
      };
      round.myCard = null;  // both cards are in reveal.entries
    }
    view.match = scoreboard;
    view.round = round;
  }

  if (room.phase === 'champion' || room.matchResultAt) {
    view.matchResultAt = room.matchResultAt;
  }
  if (room.phase === 'champion') {
    const s = standings(room);
    view.champion = {
      seat: s.champion,
      name: s.champion === null ? null : nameOf(s.champion),
      joint: s.jointChampions,
      standings: s,
    };
  }
  return view;
}

module.exports = {
  TIMING, GameError,
  newRoom, joinRoom, seatForToken, setConnected,
  applyAction, tick, viewFor, standings,
};
