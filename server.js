'use strict';
/**
 * HTTP + Server-Sent Events server. Dependency-free (Node built-ins only).
 *
 *   POST /api/rooms                      create room (host)            → { code, token, seat }
 *   POST /api/rooms/join                 join by code                  → { code, token, seat }
 *   GET  /api/rooms/:code/stream?token=  SSE stream of THIS player's view (also marks connected)
 *   POST /api/rooms/:code/action         { token, actionId, type, ... } → { ok } | error
 *   GET  /api/health
 *   GET  /                               static client in /public
 *
 * Server → client pushes use SSE (one private view per connection). Client → server
 * uses POST. Every view is produced by room.viewFor(), so private data cannot leak
 * through another player's stream.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const engine = require('./room');
const { loadPlayers } = require('./data');
const { loadRooms, saveRooms } = require('./store');

const { GameError } = engine;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function createServer(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..');
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const storeFile = options.storeFile || path.join(dataDir, 'rooms.json');
  const { players, source: playerSource } = options.players || loadPlayers(dataDir);
  const playersById = Object.fromEntries(players.map((p) => [p.id, p]));
  const playerIds = players.map((p) => p.id);
  const now = options.now || (() => Date.now());
  const rng = options.rng || Math.random;

  const rooms = options.persist === false ? new Map() : loadRooms(storeFile);
  const subs = new Map(); // code → Set<{ seat, res }>

  const ctx = () => ({ now: now(), rng, players: playersById, playerIds });
  const persist = () => { if (options.persist !== false) saveRooms(storeFile, rooms); };

  function newCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new GameError('CODE_EXHAUSTED', 'Could not allocate a room code.');
  }
  const newToken = () => crypto.randomBytes(24).toString('hex');
  const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';

  function broadcast(code) {
    const room = rooms.get(code);
    const set = subs.get(code);
    if (!room || !set) return;
    for (const sub of set) {
      if (sub.res.writableEnded) continue;
      sub.res.write(`event: state\ndata: ${JSON.stringify(engine.viewFor(room, sub.seat, ctx()))}\n\n`);
    }
  }

  function withRoom(code) {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('ROOM_NOT_FOUND', 'No room exists with that code.');
    return room;
  }

  function authSeat(room, token) {
    const seat = engine.seatForToken(room, token);
    if (seat === -1) throw new GameError('UNAUTHORIZED', 'Your session is not part of this room.');
    return seat;
  }

  // ───────────────────────────────────────────────────────── handlers
  const handlers = {
    'POST /api/rooms': (body) => {
      const token = newToken();
      const code = newCode();
      const room = engine.newRoom(code, cleanName(body.name), token, now());
      rooms.set(code, room);
      persist();
      return { code, token, seat: 0 };
    },
    'POST /api/rooms/join': (body) => {
      const code = String(body.code || '').toUpperCase().trim();
      const room = withRoom(code);
      const token = body.token && engine.seatForToken(room, body.token) !== -1 ? body.token : newToken();
      const seat = engine.joinRoom(room, cleanName(body.name), token, now());
      persist();
      broadcast(code);
      return { code, token, seat };
    },
  };

  async function route(req, res, url, body) {
    const key = `${req.method} ${url.pathname}`;
    if (handlers[key]) return send(res, 200, handlers[key](body));

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, rooms: rooms.size, playerSource, players: players.length });
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/(stream|action)$/);
    if (m) {
      const room = withRoom(m[1]);
      const code = room.code;
      if (m[2] === 'stream' && req.method === 'GET') return openStream(req, res, room, url.searchParams.get('token'));
      if (m[2] === 'action' && req.method === 'POST') {
        const seat = authSeat(room, body.token);
        const before = room.version;
        const result = engine.applyAction(room, seat, body, ctx());
        if (room.version !== before) { persist(); broadcast(code); }
        return send(res, 200, result);
      }
    }
    return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
  }

  function openStream(req, res, room, token) {
    const seat = authSeat(room, token);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sub = { seat, res };
    if (!subs.has(room.code)) subs.set(room.code, new Set());
    subs.get(room.code).add(sub);
    engine.setConnected(room, seat, true, now());
    persist();
    res.write(`event: state\ndata: ${JSON.stringify(engine.viewFor(room, seat, ctx()))}\n\n`);
    broadcast(room.code);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      subs.get(room.code).delete(sub);
      // Only mark disconnected if this was the player's last open stream.
      const stillOpen = [...subs.get(room.code)].some((s) => s.seat === seat);
      if (!stillOpen) engine.setConnected(room, seat, false, now());
      persist();
      broadcast(room.code);
    });
  }

  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function sendError(res, err) {
    const isGame = err instanceof GameError;
    const status = !isGame ? 500
      : err.code === 'ROOM_NOT_FOUND' ? 404
      : err.code === 'UNAUTHORIZED' ? 403
      : ['ROOM_FULL', 'GAME_STARTED'].includes(err.code) ? 409
      : 400;
    if (!isGame) console.error(err);
    send(res, status, { error: { code: isGame ? err.code : 'SERVER_ERROR', message: isGame ? err.message : 'Unexpected server error.' } });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
        return serveStatic(res, url.pathname);
      }
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 16 * 1024) throw new GameError('PAYLOAD_TOO_LARGE', 'Request too large.');
          chunks.push(c);
        }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
        catch { throw new GameError('BAD_JSON', 'Malformed JSON body.'); }
      }
      await route(req, res, url, body);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });

  // Background timers: bid countdowns, result banners, selection timeouts, pacing.
  const ticker = setInterval(() => {
    for (const room of rooms.values()) {
      if (['auction', 'tournament'].includes(room.phase) && engine.tick(room, ctx())) {
        persist();
        broadcast(room.code);
      }
    }
  }, options.tickMs || 250);
  ticker.unref();

  server.on('close', () => clearInterval(ticker));
  return { server, rooms, playersById, playerSource };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, playerSource } = createServer();
  server.listen(port, () => {
    console.log(`IPL TRUMP 2026 running at http://localhost:${port}`);
    console.log(`Player data: ${playerSource}`);
  });
}

module.exports = { createServer };
