'use strict';
/**
 * JSON-file persistence for rooms. Written atomically (temp file + rename) after
 * every successful mutation so a server restart never loses a tournament.
 *
 * Swap this module for a real database (Postgres/SQLite) by keeping the same
 * `loadRooms` / `saveRooms` contract.
 */
const fs = require('fs');
const path = require('path');

function loadRooms(file) {
  if (!fs.existsSync(file)) return new Map();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  return new Map(Object.entries(raw.rooms || {}));
}

function saveRooms(file, rooms) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { savedAt: new Date().toISOString(), rooms: Object.fromEntries(rooms) };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadRooms, saveRooms };
