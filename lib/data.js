'use strict';
/**
 * Reference data: IPL teams and the player database.
 *
 * PLAYER DATA POLICY
 * ------------------
 * The brief forbids presenting invented statistics as real. Therefore:
 *   - If `data/players.json` exists (verified, real records) it is loaded instead.
 *   - Otherwise a deterministic SYNTHETIC test roster is generated. Every synthetic
 *     record carries `dataSource: "SYNTHETIC_TEST"` and the name "Test <Role> NN",
 *     and the UI badges it as test data. None of these numbers describe a real player.
 *
 * Team logos are rendered as generated SVG crests from the abbreviation and colours
 * (no official trademarked logo files are bundled).
 */
const fs = require('fs');
const path = require('path');
const { CR, validateSquad } = require('./rules');

const TEAMS = Object.freeze([
  { id: 'CSK',  name: 'Chennai Super Kings',          abbr: 'CSK',  primary: '#F9CD05', secondary: '#0B3D91' },
  { id: 'MI',   name: 'Mumbai Indians',               abbr: 'MI',   primary: '#045093', secondary: '#D4A017' },
  { id: 'RCB',  name: 'Royal Challengers Bengaluru',  abbr: 'RCB',  primary: '#E10B1D', secondary: '#1B1B1B' },
  { id: 'KKR',  name: 'Kolkata Knight Riders',        abbr: 'KKR',  primary: '#3A225D', secondary: '#D4AF37' },
  { id: 'SRH',  name: 'Sunrisers Hyderabad',          abbr: 'SRH',  primary: '#F7621E', secondary: '#1C1C1C' },
  { id: 'RR',   name: 'Rajasthan Royals',             abbr: 'RR',   primary: '#EA1A85', secondary: '#254AA5' },
  { id: 'DC',   name: 'Delhi Capitals',               abbr: 'DC',   primary: '#17449B', secondary: '#EF1B23' },
  { id: 'PBKS', name: 'Punjab Kings',                 abbr: 'PBKS', primary: '#DD1F2D', secondary: '#B8BCC2' },
  { id: 'GT',   name: 'Gujarat Titans',               abbr: 'GT',   primary: '#1C2A4A', secondary: '#1DA1C4' },
  { id: 'LSG',  name: 'Lucknow Super Giants',         abbr: 'LSG',  primary: '#00A3E0', secondary: '#FF6A13' },
]);

const TEAM_BY_ID = Object.freeze(Object.fromEntries(TEAMS.map((t) => [t.id, t])));

/** mulberry32: small deterministic PRNG so the synthetic roster is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Generates the synthetic test roster. Clearly NOT real player data. */
function generateSyntheticPlayers(seed = 2026) {
  const rnd = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const flt = (lo, hi) => lo + rnd() * (hi - lo);
  const plan = [['Batter', 12], ['Bowler', 12], ['All-rounder', 8], ['Wicketkeeper', 8]];
  const players = [];

  for (const [role, count] of plan) {
    for (let i = 1; i <= count; i++) {
      const id = `T-${role.slice(0, 2).toUpperCase()}${String(i).padStart(2, '0')}`;
      const stats = {
        matches: 0, runs: 0, battingAverage: null, strikeRate: null, highestScore: null,
        centuries: 0, halfCenturies: 0, wickets: 0, bowlingAverage: null, oversBowled: 0,
        economyRate: null, catches: 0,
      };
      const batting = () => {
        const m = int(20, 120);
        const runs = m * int(18, 38);
        Object.assign(stats, {
          runs,
          battingAverage: round1(runs / (m * 0.85)),
          strikeRate: round1(flt(118, 168)),
          highestScore: int(60, 140),
          centuries: int(0, 6),
          halfCenturies: int(5, 25),
        });
        return m;
      };
      const bowling = () => {
        const w = int(15, 170);
        Object.assign(stats, {
          wickets: w,
          bowlingAverage: round1(flt(18, 36)),
          oversBowled: round1(w * flt(3.8, 5.5)),
          economyRate: round2(flt(6.8, 9.6)),
        });
        return w;
      };
      let matches;
      if (role === 'Batter' || role === 'Wicketkeeper') {
        matches = batting();
        stats.catches = int(role === 'Wicketkeeper' ? 40 : 5, role === 'Wicketkeeper' ? 110 : 40);
      } else if (role === 'Bowler') {
        matches = int(20, 120);
        bowling();
        stats.runs = int(0, 150);      // tail-end batting: no average/strike rate offered
        stats.catches = int(0, 25);
      } else {
        matches = batting();
        bowling();
        stats.catches = int(5, 45);
      }
      stats.matches = matches;

      players.push({
        id,
        name: `Test ${role} ${String(i).padStart(2, '0')}`,
        role,
        nationality: 'Synthetic',
        iplTeams: [],
        // Skewed low like a real auction pool: most players ₹0.3–3 Cr, a few stars up to ₹20 Cr.
        basePrice: Math.round((30 + 1970 * Math.pow(rnd(), 4)) / 5) * 5,
        dataSource: 'SYNTHETIC_TEST',
        photo: null,                   // no photo bundled; UI shows an initials avatar
        stats,
      });
    }
  }
  return players;
}

/** Schema check for records loaded from data/players.json. */
function validatePlayer(p) {
  const roles = ['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'];
  const errs = [];
  if (!p.id) errs.push('missing id');
  if (!p.name) errs.push('missing name');
  if (!roles.includes(p.role)) errs.push(`bad role "${p.role}"`);
  if (!Number.isInteger(p.basePrice) || p.basePrice <= 0) errs.push('basePrice must be positive integer lakh');
  if (!p.stats || typeof p.stats !== 'object') errs.push('missing stats');
  return errs;
}

/**
 * Loads the player database: verified data file if present, else synthetic roster.
 * Returns { players, source }.
 */
function loadPlayers(dataDir = path.join(__dirname, '..', 'data')) {
  const file = path.join(dataDir, 'players.json');
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.players;
    const bad = list.map((p) => [p.id, validatePlayer(p)]).filter(([, e]) => e.length);
    if (bad.length) throw new Error(`Invalid player records: ${JSON.stringify(bad)}`);
    return { players: list, source: 'data/players.json' };
  }
  return { players: generateSyntheticPlayers(), source: 'SYNTHETIC_TEST (no data/players.json found)' };
}

module.exports = {
  TEAMS, TEAM_BY_ID, loadPlayers, generateSyntheticPlayers, validatePlayer, CR, validateSquad,
};
