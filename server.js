'use strict';
/*
  Chess backend: user accounts, SQLite database, in-memory cache, daily login streak.
  No npm dependencies. Needs Node.js 22.13 or newer (uses the built-in node:sqlite).
  Run:  node server.js     then open  http://localhost:3000
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const createMultiplayer = require('./multiplayer.js');

const ALLOWED_KEYS = new Set(['chess_saves', 'chess_pz', 'chess_learn']);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const DISP_RE = /^[\p{L}\p{N} _.'-]{2,24}$/u;
const AVATARS = ['♞','♟','♛','♚','♜','♝','🦊','🐼','🦁','🐯','🐸','🐵','🦉','🐙','🦄','🐲','🚀','⭐','🔥','🌙','🎯','🧠','👑','🎩'];
const COLORS = ['#81b64c','#5c8bb0','#e0a030','#d9534f','#9b59b6','#e67e9a','#2bb5a0','#7f8c8d'];
const PRESENCE_TTL = 75 * 1000;               // no heartbeat for this long means offline

/* ---------- cache: small TTL + LRU map ---------- */
class TTLCache {
  constructor(max = 5000, now = Date.now) { this.m = new Map(); this.max = max; this.now = now; }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.x < this.now()) { this.m.delete(k); return undefined; }
    this.m.delete(k); this.m.set(k, e);           // mark as recently used
    return e.v;
  }
  set(k, v, ttlMs) {
    this.m.delete(k);
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, x: this.now() + ttlMs });
  }
  del(k) { this.m.delete(k); }
  delPrefix(p) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
  sweep() { const t = this.now(); for (const [k, e] of this.m) if (e.x < t) this.m.delete(k); }
  get size() { return this.m.size; }
}

/* ---------- daily streak rules (pure functions) ---------- */
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
// The browser sends its local date so a streak follows the player's own midnight.
// It is only trusted when it is within one day of the server's UTC date (covers every time zone).
function pickDay(clientDay, nowMs) {
  const utc = utcDay(nowMs);
  if (typeof clientDay === 'string' && DAY_RE.test(clientDay) && !isNaN(dayNum(clientDay)) &&
      Math.abs(dayNum(clientDay) - dayNum(utc)) <= 1) return clientDay;
  return utc;
}
function nextStreak(last, today, streak, best) {
  if (last && dayNum(today) <= dayNum(last)) return { streak, best, changed: false };
  const ns = last && dayNum(today) - dayNum(last) === 1 ? streak + 1 : 1;
  return { streak: ns, best: Math.max(best, ns), changed: true };
}
// Streak to show when the player hasn't logged in today yet: still alive if they logged in yesterday.
function liveStreak(last, today, streak) {
  if (!last) return 0;
  const gap = dayNum(today) - dayNum(last);
  return gap <= 1 ? streak : 0;
}

function makeServer(opts = {}) {
  const now = opts.now || Date.now;
  const dbPath = opts.dbPath || process.env.DB_PATH || path.join(__dirname, 'chess.db');
  const htmlPath = opts.htmlPath || process.env.HTML_PATH || path.join(__dirname, 'Chess.html');
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const trustProxy = process.env.TRUST_PROXY === '1';

  /* ---------- database ---------- */
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_date TEXT,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      total_days INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS kv(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      k TEXT NOT NULL,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,k)
    );
    CREATE TABLE IF NOT EXISTS login_days(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      PRIMARY KEY(user_id,day)
    );
  `);
  // add the profile + status columns to databases made by an earlier version
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  const addCol = (n, def) => { if (!cols.has(n)) db.exec('ALTER TABLE users ADD COLUMN ' + n + ' ' + def); };
  addCol('avatar', "TEXT NOT NULL DEFAULT '♞'");
  addCol('color', "TEXT NOT NULL DEFAULT '#81b64c'");
  addCol('bio', "TEXT NOT NULL DEFAULT ''");
  addCol('presence', "TEXT NOT NULL DEFAULT 'offline'");
  addCol('last_seen', 'INTEGER NOT NULL DEFAULT 0');
  addCol('rating', 'INTEGER NOT NULL DEFAULT 1200');
  addCol('wins', 'INTEGER NOT NULL DEFAULT 0');
  addCol('losses', 'INTEGER NOT NULL DEFAULT 0');
  addCol('draws', 'INTEGER NOT NULL DEFAULT 0');
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username=?'),
    userById: db.prepare('SELECT * FROM users WHERE id=?'),
    addUser: db.prepare('INSERT INTO users(username,display,salt,hash,created_at) VALUES(?,?,?,?,?)'),
    addSession: db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)'),
    sessByHash: db.prepare('SELECT s.user_id,s.expires_at,u.username,u.display FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    delExpired: db.prepare('DELETE FROM sessions WHERE expires_at<?'),
    setStreak: db.prepare('UPDATE users SET last_login_date=?,streak=?,best_streak=?,total_days=total_days+1 WHERE id=?'),
    addDay: db.prepare('INSERT OR IGNORE INTO login_days(user_id,day) VALUES(?,?)'),
    recentDays: db.prepare('SELECT day FROM login_days WHERE user_id=? ORDER BY day DESC LIMIT 30'),
    kvAll: db.prepare('SELECT k,v,updated_at FROM kv WHERE user_id=?'),
    kvPut: db.prepare('INSERT INTO kv(user_id,k,v,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at'),
    kvDel: db.prepare('DELETE FROM kv WHERE user_id=? AND k=?'),
    rank: db.prepare('SELECT COUNT(*)+1 AS n FROM users WHERE rating>?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    rankings: db.prepare('SELECT display,avatar,color,presence,last_seen,rating,wins,losses,draws FROM users ORDER BY rating DESC, wins DESC, id ASC LIMIT 10'),
    setProfile: db.prepare('UPDATE users SET display=?,avatar=?,color=?,bio=? WHERE id=?'),
    setPw: db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?'),
    delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?'),
    setPresence: db.prepare('UPDATE users SET presence=?,last_seen=? WHERE id=?'),
    players: db.prepare('SELECT display,avatar,color,presence,last_seen,streak,last_login_date,rating FROM users ORDER BY last_seen DESC LIMIT 60'),
    top: db.prepare('SELECT display,avatar,color,presence,last_seen,streak,best_streak,last_login_date FROM users ORDER BY best_streak DESC, streak DESC LIMIT 10'),
  };

  /* ---------- caches ---------- */
  const cache = new TTLCache(5000, now);   // sessions, kv reads, leaderboard
  const limits = new TTLCache(20000, now); // rate-limit counters
  function hit(key, limit, windowMs) {
    const e = limits.get(key) || { n: 0, reset: now() + windowMs };
    e.n++; limits.set(key, e, Math.max(1, e.reset - now()));
    return e.n <= limit;
  }

  /* ---------- helpers ---------- */
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k)));
  async function hashPw(pw, salt) { return (await scrypt(pw, salt)).toString('hex'); }
  async function checkPw(pw, u) {
    const a = Buffer.from(await hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.addSession.run(sha(token), userId, now(), now() + SESSION_MS);
    return token;
  }
  function auth(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return null;
    const th = sha(m[1]);
    let s = cache.get('sess:' + th);
    if (s === undefined) {
      s = q.sessByHash.get(th) || null;
      cache.set('sess:' + th, s, 60000);
    }
    if (!s) return null;
    if (s.expires_at < now()) { q.delSession.run(th); cache.del('sess:' + th); return null; }
    return { userId: s.user_id, username: s.username, display: s.display, th };
  }
  function streakInfo(userId, day) {
    const u = q.userById.get(userId);
    const today = pickDay(day, now());
    return {
      streak: liveStreak(u.last_login_date, today, u.streak),
      best: u.best_streak,
      lastDay: u.last_login_date,
      today,
      totalDays: u.total_days,
      checkedInToday: u.last_login_date === today,
      recentDays: q.recentDays.all(userId).map(r => r.day),
    };
  }
  function checkin(userId, day) {
    const today = pickDay(day, now());
    db.exec('BEGIN IMMEDIATE');
    try {
      const u = q.userById.get(userId);
      const r = nextStreak(u.last_login_date, today, u.streak, u.best_streak);
      if (r.changed) {
        q.setStreak.run(today, r.streak, r.best, userId);
        q.addDay.run(userId, today);
        cache.del('board');
      }
      db.exec('COMMIT');
      setStatus(userId, 'online');
      return { ...streakInfo(userId, today), changed: r.changed };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const statusOf = u => (u.presence !== 'offline' && now() - u.last_seen <= PRESENCE_TTL) ? u.presence : 'offline';
  const publicUser = u => ({ name: u.display, key: u.username, avatar: u.avatar, color: u.color, bio: u.bio, status: statusOf(u), rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, rank: q.rank.get(u.rating).n, players: q.userCount.get().n, since: u.created_at });
  const setStatus = (userId, state) => { q.setPresence.run(state, state === 'offline' ? 0 : now(), userId); cache.del('players'); };
  const ip = req => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';

  function readBody(req) {
    return new Promise((res, rej) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > MAX_BODY) { rej(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return res({});
        try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { rej(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', rej);
    });
  }
  function send(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...extra,
    });
    res.end(body);
  }
  const fail = (res, status, msg) => send(res, status, { error: msg });
  const mp = createMultiplayer({ db, now, send, fail, readBody, corsOrigin, abandonMs: opts.abandonMs });

  /* ---------- request handler ---------- */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

    if (req.method === 'GET' && (p === '/' || p === '/Chess.html')) {
      let html = cache.get('html');
      if (!html) {
        try { html = fs.readFileSync(htmlPath); } catch (e) { return fail(res, 404, 'Chess.html not found next to server.js'); }
        cache.set('html', html, 5000);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(html); return;
    }
    if (!p.startsWith('/api/')) return fail(res, 404, 'Not found');

    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: now() });

    if (req.method === 'GET' && p === '/api/leaderboard') {
      let b = cache.get('board');
      if (!b) {
        b = q.top.all().map(r => ({ name: r.display, avatar: r.avatar, color: r.color, status: statusOf(r), streak: liveStreak(r.last_login_date, utcDay(now()), r.streak), best: r.best_streak }));
        cache.set('board', b, 15000);
      }
      return send(res, 200, { top: b });
    }

    if (req.method === 'GET' && p === '/api/rankings') {
      let r = cache.get('rankings');
      if (!r) {
        r = q.rankings.all().map((u, i) => ({ pos: i + 1, name: u.display, avatar: u.avatar, color: u.color, status: statusOf(u), rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws }));
        cache.set('rankings', r, 15000);
      }
      return send(res, 200, { top: r });
    }

    if (req.method === 'GET' && p === '/api/players') {
      let list = cache.get('players');
      if (!list) {
        const rank = { online: 0, idle: 1, offline: 2 };
        list = q.players.all().map(r => ({ name: r.display, avatar: r.avatar, color: r.color, status: statusOf(r), rating: r.rating, streak: liveStreak(r.last_login_date, utcDay(now()), r.streak) }))
          .sort((a, b) => rank[a.status] - rank[b.status]).slice(0, 20);
        cache.set('players', list, 8000);
      }
      return send(res, 200, { players: list });
    }

    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      if (!hit('ip:' + ip(req), 30, 10 * 60000)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
      const body = await readBody(req);
      const name = String(body.username || '').trim(), pw = String(body.password || '');
      const key = name.toLowerCase();
      if (!NAME_RE.test(name)) return fail(res, 400, 'Username: 3–20 letters, numbers, _ . or -');
      if (pw.length < 6 || pw.length > 128) return fail(res, 400, 'Password must be 6–128 characters.');
      if (key === 'guest') return fail(res, 400, 'That username is reserved.');
      let user;
      if (p === '/api/register') {
        if (q.userByName.get(key)) return fail(res, 409, 'That username is taken.');
        const salt = crypto.randomBytes(16).toString('hex');
        const r = q.addUser.run(key, name, salt, await hashPw(pw, salt), now());
        user = q.userById.get(Number(r.lastInsertRowid));
      } else {
        const fails = limits.get('fail:' + key);
        if (fails && fails.n >= 8) return fail(res, 429, 'Too many wrong passwords for this account. Try again in 10 minutes.');
        user = q.userByName.get(key);
        if (!user || !(await checkPw(pw, user))) {
          hit('fail:' + key, 1e9, 10 * 60000);
          return fail(res, 401, 'Wrong username or password.');
        }
        limits.del('fail:' + key);
      }
      const token = newSession(user.id);
      const streak = checkin(user.id, body.day);
      return send(res, p === '/api/register' ? 201 : 200, { token, user: publicUser(q.userById.get(user.id)), streak });
    }

    if (req.method === 'GET' && p === '/api/stream') { mp.openStream(req, res, url); return; }

    /* ----- everything below needs a session ----- */
    const a = auth(req);
    if (!a) return fail(res, 401, 'Please sign in.');

    if (await mp.handle(req, res, url, a)) return;

    if (req.method === 'POST' && p === '/api/logout') {
      q.delSession.run(a.th); cache.del('sess:' + a.th); setStatus(a.userId, 'offline');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/me') {
      return send(res, 200, { user: publicUser(q.userById.get(a.userId)), streak: streakInfo(a.userId, url.searchParams.get('day')) });
    }
    if (req.method === 'POST' && p === '/api/checkin') {
      const body = await readBody(req);
      const st = checkin(a.userId, body.day);
      return send(res, 200, { streak: st, user: publicUser(q.userById.get(a.userId)) });
    }
    if (req.method === 'POST' && p === '/api/presence') {
      const body = await readBody(req);
      if (body.state !== 'online' && body.state !== 'idle') return fail(res, 400, 'state must be online or idle');
      setStatus(a.userId, body.state);
      return send(res, 200, { status: body.state });
    }
    if (req.method === 'PUT' && p === '/api/profile') {
      const body = await readBody(req), u = q.userById.get(a.userId);
      let display = u.display, avatar = u.avatar, color = u.color, bio = u.bio;
      if ('display' in body) {
        display = String(body.display || '').trim().replace(/\s+/g, ' ');
        if (!DISP_RE.test(display)) return fail(res, 400, 'Display name: 2–24 letters, numbers, spaces, _ . - or \'');
      }
      if ('avatar' in body) { if (!AVATARS.includes(body.avatar)) return fail(res, 400, 'Pick an avatar from the list.'); avatar = body.avatar; }
      if ('color' in body) { if (!COLORS.includes(body.color)) return fail(res, 400, 'Pick a colour from the list.'); color = body.color; }
      if ('bio' in body) { bio = String(body.bio || '').replace(/[\u0000-\u001f<>&]/g, '').trim(); if (bio.length > 80) return fail(res, 400, 'About you can be at most 80 characters.'); }
      q.setProfile.run(display, avatar, color, bio, a.userId);
      cache.del('board'); cache.del('players');
      return send(res, 200, { user: publicUser(q.userById.get(a.userId)) });
    }
    if (req.method === 'POST' && p === '/api/password') {
      if (!hit('pw:' + a.userId, 10, 10 * 60000)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
      const body = await readBody(req), u = q.userById.get(a.userId);
      const oldPw = String(body.oldPassword || ''), newPw = String(body.newPassword || '');
      if (!(await checkPw(oldPw, u))) return fail(res, 401, 'Your current password is wrong.');
      if (newPw.length < 6 || newPw.length > 128) return fail(res, 400, 'New password must be 6–128 characters.');
      const salt = crypto.randomBytes(16).toString('hex');
      q.setPw.run(salt, await hashPw(newPw, salt), a.userId);
      q.delOtherSessions.run(a.userId, a.th);       // sign out every other device
      cache.delPrefix('sess:');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/store') {
      let all = cache.get('kv:' + a.userId);
      if (!all) {
        all = {};
        for (const r of q.kvAll.all(a.userId)) all[r.k] = { raw: r.v, updated_at: r.updated_at };
        cache.set('kv:' + a.userId, all, 5 * 60000);
      }
      const out = {};
      for (const k of Object.keys(all)) out[k] = { value: JSON.parse(all[k].raw), updated_at: all[k].updated_at };
      return send(res, 200, out);
    }
    const m = /^\/api\/store\/([A-Za-z0-9_]+)$/.exec(p);
    if (m) {
      const key = m[1];
      if (!ALLOWED_KEYS.has(key)) return fail(res, 400, 'Unknown data key.');
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!('value' in body)) return fail(res, 400, 'Missing value.');
        const raw = JSON.stringify(body.value);
        if (raw === undefined || raw.length > MAX_BODY) return fail(res, 413, 'Value too large.');
        const t = now();
        q.kvPut.run(a.userId, key, raw, t);
        cache.del('kv:' + a.userId);               // invalidate on write
        return send(res, 200, { updated_at: t });
      }
      if (req.method === 'DELETE') {
        q.kvDel.run(a.userId, key); cache.del('kv:' + a.userId);
        return send(res, 200, { ok: true });
      }
    }
    return fail(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Server error');
      if (!e.status) console.error(e);
    });
  });
  const timer = setInterval(() => { try { q.delExpired.run(now()); cache.sweep(); limits.sweep(); } catch (e) {} }, 3600000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); try { db.close(); } catch (e) {} });
  return { server, db, cache, mp };
}

module.exports = { makeServer, TTLCache, pickDay, nextStreak, liveStreak, AVATARS, COLORS };

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  const { server } = makeServer();
  server.listen(port, () => console.log('Chess server running on http://localhost:' + port));
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
