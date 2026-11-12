'use strict';
/**
 * IPL TRUMP 2026 – pure rules engine (no I/O, no randomness of its own).
 *
 * All money is stored as integer LAKH (1 Crore = 100 lakh) to avoid float drift.
 */

const CR = 100;                       // 1 crore in lakh units
const PURSE = 120 * CR;               // ₹120 Cr starting purse
const MIN_RESERVE_PER_PLAYER = 50;    // ₹0.5 Cr held back per still-needed squad slot
const SQUAD_RULES = Object.freeze({
  min: 15,
  max: 18,
  minBatters: 4,
  minBowlers: 4,
  minWicketkeepers: 1,
});
const TOTAL_MATCHES = 14;
const ROUNDS_PER_MATCH = 11;
const POINTS = Object.freeze({ win: 2, draw: 1, loss: 0 });

/**
 * Category definitions.
 *  - `stat`  : key of the stat on the player record (same name as the category key)
 *  - `scale` : the normalisation window. The value is mapped linearly onto 0..100:
 *              score = clamp((value - worst) / (best - worst), 0, 1) * 100
 *              If worst > best the category is "lower is better" (bowling average, economy).
 *  - `requires`: an extra stat that must be > 0 for the category to be meaningful
 *                (bowling categories need overs bowled, so a batter's "0 wickets" is not offered).
 */
const CATEGORIES = Object.freeze({
  matches:        { label: 'Matches',         group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 300 } },
  runs:           { label: 'Runs',            group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 8000 } },
  battingAverage: { label: 'Batting Average', group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 60 },  requires: 'runs' },
  strikeRate:     { label: 'Strike Rate',     group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 200 }, requires: 'runs' },
  highestScore:   { label: 'Highest Score',   group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 180 }, requires: 'runs' },
  centuries:      { label: 'Centuries',       group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 10 } },
  halfCenturies:  { label: 'Half Centuries',  group: 'BATTING',  higherIsBetter: true,  scale: { worst: 0,  best: 60 } },
  wickets:        { label: 'Wickets',         group: 'BOWLING',  higherIsBetter: true,  scale: { worst: 0,  best: 250 }, requires: 'oversBowled' },
  bowlingAverage: { label: 'Bowling Average', group: 'BOWLING',  higherIsBetter: false, scale: { worst: 50, best: 15 },  requires: 'wickets' },
  economyRate:    { label: 'Economy Rate',    group: 'BOWLING',  higherIsBetter: false, scale: { worst: 11, best: 6 },   requires: 'oversBowled' },
  catches:        { label: 'Catches',         group: 'FIELDING', higherIsBetter: true,  scale: { worst: 0,  best: 150 } },
});

const CATEGORY_KEYS = Object.freeze(Object.keys(CATEGORIES));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Minimum legal raise over the current high bid. */
function bidIncrement(currentHigh) {
  if (currentHigh < 100) return 5;   // below ₹1 Cr: ₹5 lakh steps
  if (currentHigh < 500) return 10;  // below ₹5 Cr: ₹10 lakh steps
  return 25;                         // above ₹5 Cr: ₹25 lakh steps
}

/**
 * Categories a player may legally choose: stat present, and any prerequisite
 * stat (e.g. wickets for bowling average) is greater than zero.
 */
function availableCategories(player) {
  const stats = (player && player.stats) || {};
  return CATEGORY_KEYS.filter((key) => {
    const cat = CATEGORIES[key];
    if (!isNum(stats[key])) return false;
    if (cat.requires && !(isNum(stats[cat.requires]) && stats[cat.requires] > 0)) return false;
    return true;
  });
}

/** Normalises a raw stat to a 0..100 comparable score (2 dp). */
function normalize(key, value) {
  const cat = CATEGORIES[key];
  if (!cat) throw Object.assign(new Error(`Unknown category "${key}"`), { code: 'INVALID_CATEGORY' });
  if (!isNum(value)) throw Object.assign(new Error(`Missing statistic "${key}"`), { code: 'MISSING_STAT' });
  const { worst, best } = cat.scale;
  const t = (value - worst) / (best - worst);
  const clamped = Math.min(1, Math.max(0, t));
  return Math.round(clamped * 10000) / 100;
}

/**
 * Compares two round entries ({ category, value }) on normalised scores.
 * Returns { scoreA, scoreB, winner } where winner is 0, 1 or null (equal → no point).
 */
function compareRound(a, b) {
  const scoreA = normalize(a.category, a.value);
  const scoreB = normalize(b.category, b.value);
  let winner = null;
  if (scoreA > scoreB) winner = 0;
  else if (scoreB > scoreA) winner = 1;
  return { scoreA, scoreB, winner };
}

/** Squad validation against SQUAD_RULES. players: array of player records. */
function validateSquad(players) {
  const problems = [];
  const n = players.length;
  const count = (role) => players.filter((p) => p.role === role).length;
  if (n < SQUAD_RULES.min) problems.push(`Needs at least ${SQUAD_RULES.min} players (has ${n})`);
  if (n > SQUAD_RULES.max) problems.push(`Cannot exceed ${SQUAD_RULES.max} players (has ${n})`);
  if (count('Batter') < SQUAD_RULES.minBatters) problems.push(`Needs at least ${SQUAD_RULES.minBatters} batters`);
  if (count('Bowler') < SQUAD_RULES.minBowlers) problems.push(`Needs at least ${SQUAD_RULES.minBowlers} bowlers`);
  if (count('Wicketkeeper') < SQUAD_RULES.minWicketkeepers) problems.push(`Needs at least ${SQUAD_RULES.minWicketkeepers} wicketkeeper`);
  return { valid: problems.length === 0, problems };
}

/** Human-readable money, e.g. 1234 → "₹12.34 Cr". */
function formatLakh(lakh) {
  return `₹${(lakh / CR).toFixed(2)} Cr`;
}

module.exports = {
  CR, PURSE, MIN_RESERVE_PER_PLAYER, SQUAD_RULES, TOTAL_MATCHES, ROUNDS_PER_MATCH, POINTS,
  CATEGORIES, CATEGORY_KEYS,
  bidIncrement, availableCategories, normalize, compareRound, validateSquad, formatLakh,
};
