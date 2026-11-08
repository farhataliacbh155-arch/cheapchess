'use strict';
/*
  Online multiplayer: matchmaking queue, live games, clocks, resign / draw, ratings and history.
  The server checks every move with the same rules as the page (engine.js) and decides the result.
  Players get live updates over Server-Sent Events (GET /api/stream).
*/
const crypto = require('node:crypto');
const E = require('./engine.js');

const TCS = {
  'inf':  { base: 0,        inc: 0,     label: 'Unlimited' },
  '3+0':  { base: 180000,   inc: 0,     label: '3 min' },
  '5+0':  { base: 300000,   inc: 0,     label: '5 min' },
  '10+0': { base: 600000,   inc: 0,     label: '10 min' },
  '15+10':{ base: 900000,   inc: 10000, label: '15 | 10' },
};
const START_RATING = 1200, K = 32;

module.exports = function createMultiplayer(ctx) {
  const { db, now, send, fail, readBody, corsOrigin } = ctx;
  const abandonMs = ctx.abandonMs || 60000;

  db.exec(`
    CREATE TABLE IF NOT EXISTS games(
      id TEXT PRIMARY KEY, tc TEXT NOT NULL,
      white_id INTEGER NOT NULL, black_id INTEGER NOT NULL,
      white_name TEXT NOT NULL, black_name TEXT NOT NULL,
      white_before INTEGER NOT NULL, black_before INTEGER NOT NULL,
      white_after INTEGER NOT NULL, black_after INTEGER NOT NULL,
      result TEXT NOT NULL, reason TEXT NOT NULL, moves TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_white ON games(white_id, ended_at);
    CREATE INDEX IF NOT EXISTS games_black ON games(black_id, ended_at);
  `);
  const q = {
    user: db.prepare('SELECT id,display,avatar,color,rating,wins,losses,draws FROM users WHERE id=?'),
    addGame: db.prepare('INSERT INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    setStats: db.prepare('UPDATE users SET rating=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE id=?'),
    history: db.prepare('SELECT * FROM games WHERE white_id=? OR black_id=? ORDER BY ended_at DESC LIMIT 20'),
  };

  const queue = [];                 // { userId, tc }
  const games = new Map();          // id -> game (playing)
  const userGame = new Map();       // userId -> game id
  const lastEnded = new Map();      // userId -> final snapshot (kept for a while)
  const streams = new Map();        // userId -> Set(res)
  const tickets = new Map();        // one-time stream tickets
  const discTimers = new Map();     // userId -> timer

  const tcOf = tc => TCS[tc] ? tc : null;
  const hasStream = id => (streams.get(id) || new Set()).size > 0;

  /* ---------- live events ---------- */
  function emit(userId, event, data) {
    for (const r of streams.get(userId) || []) {
      try { r.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
    }
  }
  const both = (g, event, data) => { emit(g.white.userId, event, data); emit(g.black.userId, event, data); };

  /* ---------- game helpers ---------- */
  function player(userId) {
    const u = q.user.get(userId);
    return { userId, name: u.display, avatar: u.avatar, color: u.color, rating: u.rating };
  }
  const pub = p => ({ name: p.name, avatar: p.avatar, color: p.color, rating: p.rating });
  function clocksNow(g) {
    if (!g.base) return null;
    const c = { w: g.clock.w, b: g.clock.b };
    if (g.status === 'playing') c[g.S.t] = Math.max(0, c[g.S.t] - (now() - g.turnStart));
    return c;
  }
  function snapshot(g, userId) {
    return {
      id: g.id, tc: g.tc, label: TCS[g.tc].label, base: g.base, inc: g.inc,
      white: pub(g.white), black: pub(g.black),
      you: g.white.userId === userId ? 'w' : g.black.userId === userId ? 'b' : null,
      moves: g.moves.slice(), turn: g.S.t, clocks: clocksNow(g),
      status: g.status, result: g.result || null, reason: g.reason || null,
      drawOffer: g.drawOffer || null, ratings: g.ratings || null,
    };
  }
  function clearTimers(g) { clearTimeout(g.timer); }
  function scheduleClock(g) {
    clearTimeout(g.timer);
    if (!g.base || g.status !== 'playing') return;
    const left = g.clock[g.S.t] - (now() - g.turnStart);
    g.timer = setTimeout(() => tick(), Math.max(50, left + 30));
    if (g.timer.unref) g.timer.unref();
  }
  // Ends any game whose side to move has run out of time (also called by timers).
  function tick() {
    for (const g of [...games.values()]) {
      if (g.status === 'playing' && g.base && g.clock[g.S.t] - (now() - g.turnStart) <= 0) {
        endGame(g, g.S.t === 'w' ? '0-1' : '1-0', 'timeout');
      }
    }
  }

  function startGame(a, b, tcKey) {
    const flip = crypto.randomInt(2) === 1;
    const wp = player(flip ? b : a), bp = player(flip ? a : b), tc = TCS[tcKey];
    const g = {
      id: crypto.randomBytes(6).toString('hex'), tc: tcKey, base: tc.base, inc: tc.inc,
      white: wp, black: bp, S: E.startState(), hist: [], moves: [], sans: [],
      clock: { w: tc.base, b: tc.base }, turnStart: now(), startedAt: now(),
      status: 'playing', drawOffer: null, timer: null,
    };
    games.set(g.id, g); userGame.set(wp.userId, g.id); userGame.set(bp.userId, g.id);
    lastEnded.delete(wp.userId); lastEnded.delete(bp.userId);
    scheduleClock(g);
    emit(wp.userId, 'matched', { game: snapshot(g, wp.userId) });
    emit(bp.userId, 'matched', { game: snapshot(g, bp.userId) });
    return g;
  }

  function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }
  function endGame(g, result, reason) {
    if (g.status !== 'playing') return;
    g.status = 'ended'; g.result = result; g.reason = reason; clearTimers(g);
    const rated = g.moves.length >= 2 && result !== '*';
    const wb = g.white.rating, bb = g.black.rating;
    let wa = wb, ba = bb;
    if (rated) {
      const sw = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
      const d = Math.round(K * (sw - expected(wb, bb)));
      wa = Math.max(100, wb + d); ba = Math.max(100, bb - d);
      q.setStats.run(wa, sw === 1 ? 1 : 0, sw === 0 ? 1 : 0, sw === 0.5 ? 1 : 0, g.white.userId);
      q.setStats.run(ba, sw === 0 ? 1 : 0, sw === 1 ? 1 : 0, sw === 0.5 ? 1 : 0, g.black.userId);
      q.addGame.run(g.id, g.tc, g.white.userId, g.black.userId, g.white.name, g.black.name, wb, bb, wa, ba, result, reason, JSON.stringify(g.moves), g.startedAt, now());
    } else if (g.moves.length >= 2) {
      q.addGame.run(g.id, g.tc, g.white.userId, g.black.userId, g.white.name, g.black.name, wb, bb, wb, bb, result, reason, JSON.stringify(g.moves), g.startedAt, now());
    }
    g.ratings = { w: { before: wb, after: wa }, b: { before: bb, after: ba } };
    g.white.rating = wa; g.black.rating = ba;
    for (const p of [g.white, g.black]) {
      userGame.delete(p.userId);
      clearTimeout(discTimers.get(p.userId)); discTimers.delete(p.userId);
    }
    games.delete(g.id);
    const final = id => snapshot(g, id);
    lastEnded.set(g.white.userId, final(g.white.userId)); lastEnded.set(g.black.userId, final(g.black.userId));
    const ev = { gameId: g.id, result, reason, ratings: g.ratings, aborted: !rated };
    both(g, 'end', ev);
    const t = setTimeout(() => { for (const p of [g.white, g.black]) { const l = lastEnded.get(p.userId); if (l && l.id === g.id) lastEnded.delete(p.userId); } }, 10 * 60000);
    if (t.unref) t.unref();
  }

  function applyMove(g, userId, body) {
    const color = g.white.userId === userId ? 'w' : g.black.userId === userId ? 'b' : null;
    if (!color) return { status: 403, error: 'You are not in this game.' };
    if (g.status !== 'playing') return { status: 409, error: 'This game is over.' };
    if (g.S.t !== color) return { status: 409, error: 'Not your turn.' };
    const from = +body.from, to = +body.to, promo = String(body.promo || '');
    const m = E.legal(g.S).find(x => x.from === from && x.to === to && (x.promo || '') === promo);
    if (!m) return { status: 400, error: 'Illegal move.' };
    if (g.base) {
      g.clock[color] -= now() - g.turnStart;
      if (g.clock[color] <= 0) { g.clock[color] = 0; endGame(g, color === 'w' ? '0-1' : '1-0', 'timeout'); return { status: 409, error: 'You ran out of time.' }; }
      g.clock[color] += g.inc;
    }
    const ls = E.legal(g.S), ns = E.apply(g.S, m), nl = E.legal(ns), chk = E.inCheck(ns, ns.t);
    const sn = E.san(g.S, m, ls) + (nl.length ? (chk ? '+' : '') : (chk ? '#' : ''));
    g.hist.push(g.S); g.S = ns; g.turnStart = now(); g.drawOffer = null;
    g.moves.push([from, to, promo]); g.sans.push(sn);
    both(g, 'move', { gameId: g.id, ply: g.moves.length, from, to, promo, san: sn, turn: ns.t, clocks: clocksNow(g) });
    const end = E.endOf(ns, g.hist);
    if (end) endGame(g, end.result, end.reason); else scheduleClock(g);
    return { status: 200, ok: true, ply: g.moves.length };
  }

  /* ---------- matchmaking ---------- */
  function find(userId, tcKey) {
    if (userGame.has(userId)) return { game: snapshot(games.get(userGame.get(userId)), userId) };
    const i0 = queue.findIndex(x => x.userId === userId); if (i0 >= 0) queue.splice(i0, 1);
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      if (w.tc !== tcKey || w.userId === userId) continue;
      if (!hasStream(w.userId) || userGame.has(w.userId)) { queue.splice(i--, 1); continue; }
      queue.splice(i, 1);
      const g = startGame(w.userId, userId, tcKey);
      return { game: snapshot(g, userId) };
    }
    queue.push({ userId, tc: tcKey });
    return { queued: true, tc: tcKey, waiting: queue.filter(x => x.tc === tcKey).length };
  }
  function cancel(userId) { const i = queue.findIndex(x => x.userId === userId); if (i >= 0) queue.splice(i, 1); }

  /* ---------- streams ---------- */
  function openStream(req, res, url) {
    const t = url.searchParams.get('ticket'), e = tickets.get(t);
    tickets.delete(t);                                  // single use
    if (!e || e.exp < now()) return fail(res, 401, 'Stream ticket expired. Reconnect.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin, 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const uid = e.userId;
    if (!streams.has(uid)) streams.set(uid, new Set());
    streams.get(uid).add(res);
    clearTimeout(discTimers.get(uid)); discTimers.delete(uid);
    const g = userGame.has(uid) ? games.get(userGame.get(uid)) : null;
    if (g) {
      const opp = g.white.userId === uid ? g.black.userId : g.white.userId;
      emit(opp, 'opponent', { gameId: g.id, state: 'connected' });
    }
    emit(uid, 'hello', { game: g ? snapshot(g, uid) : (lastEnded.get(uid) || null) });
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (err) {} }, 20000);
    req.on('close', () => {
      clearInterval(ka);
      const set = streams.get(uid); if (set) { set.delete(res); if (!set.size) streams.delete(uid); }
      if (hasStream(uid)) return;
      cancel(uid);                                       // stop searching when you leave
      const gid = userGame.get(uid), gm = gid && games.get(gid);
      if (gm) {
        const opp = gm.white.userId === uid ? gm.black.userId : gm.white.userId;
        emit(opp, 'opponent', { gameId: gm.id, state: 'disconnected', seconds: Math.round(abandonMs / 1000) });
        clearTimeout(discTimers.get(uid));
        const tm = setTimeout(() => {
          if (hasStream(uid) || gm.status !== 'playing') return;
          if (gm.moves.length < 2) endGame(gm, '*', 'aborted');
          else endGame(gm, gm.white.userId === uid ? '0-1' : '1-0', 'abandonment');
        }, abandonMs);
        if (tm.unref) tm.unref();
        discTimers.set(uid, tm);
      }
    });
  }

  /* ---------- HTTP routes (after sign-in) ---------- */
  async function handle(req, res, url, a) {
    const p = url.pathname;
    if (req.method === 'POST' && p === '/api/stream/ticket') {
      const t = crypto.randomBytes(18).toString('base64url');
      tickets.set(t, { userId: a.userId, exp: now() + 30000 });
      for (const [k, v] of tickets) if (v.exp < now()) tickets.delete(k);
      return send(res, 200, { ticket: t }), true;
    }
    if (req.method === 'POST' && p === '/api/match/find') {
      const body = await readBody(req), tc = tcOf(body.tc);
      if (!tc) return fail(res, 400, 'Unknown time control.'), true;
      if (!hasStream(a.userId)) return fail(res, 409, 'Not connected to the match server yet. Try again in a moment.'), true;
      return send(res, 200, find(a.userId, tc)), true;
    }
    if (req.method === 'POST' && p === '/api/match/cancel') { cancel(a.userId); return send(res, 200, { ok: true }), true; }
    if (req.method === 'GET' && p === '/api/game/current') {
      const g = userGame.has(a.userId) ? games.get(userGame.get(a.userId)) : null;
      return send(res, 200, { game: g ? snapshot(g, a.userId) : (lastEnded.get(a.userId) || null) }), true;
    }
    if (req.method === 'GET' && p === '/api/history') {
      const rows = q.history.all(a.userId, a.userId).map(r => {
        const white = r.white_id === a.userId;
        const win = r.result === '1-0' ? white : r.result === '0-1' ? !white : null;
        return {
          id: r.id, tc: r.tc, label: (TCS[r.tc] || {}).label || r.tc, you: white ? 'w' : 'b',
          opponent: white ? r.black_name : r.white_name, result: r.result, reason: r.reason,
          outcome: win === null ? 'draw' : win ? 'win' : 'loss',
          ratingBefore: white ? r.white_before : r.black_before, ratingAfter: white ? r.white_after : r.black_after,
          moves: JSON.parse(r.moves), endedAt: r.ended_at,
        };
      });
      return send(res, 200, { games: rows }), true;
    }
    const m = /^\/api\/game\/([0-9a-f]{12})\/(move|resign|draw)$/.exec(p);
    if (m && req.method === 'POST') {
      const g = games.get(m[1]);
      if (!g) return fail(res, 404, 'That game is not running.'), true;
      const color = g.white.userId === a.userId ? 'w' : g.black.userId === a.userId ? 'b' : null;
      if (!color) return fail(res, 403, 'You are not in this game.'), true;
      const body = await readBody(req);
      if (m[2] === 'move') {
        const r = applyMove(g, a.userId, body);
        return r.error ? fail(res, r.status, r.error) : send(res, 200, { ok: true, ply: r.ply }), true;
      }
      if (m[2] === 'resign') { endGame(g, color === 'w' ? '0-1' : '1-0', 'resignation'); return send(res, 200, { ok: true }), true; }
      const act = body.action;                           // draw
      const opp = color === 'w' ? g.black.userId : g.white.userId;
      if (act === 'offer') {
        if (g.drawOffer === color) return send(res, 200, { ok: true }), true;
        if (g.drawOffer && g.drawOffer !== color) { endGame(g, '1/2-1/2', 'agreement'); return send(res, 200, { ok: true }), true; }
        g.drawOffer = color; emit(opp, 'draw', { gameId: g.id, from: color }); return send(res, 200, { ok: true }), true;
      }
      if (act === 'accept' && g.drawOffer && g.drawOffer !== color) { endGame(g, '1/2-1/2', 'agreement'); return send(res, 200, { ok: true }), true; }
      if (act === 'decline' && g.drawOffer && g.drawOffer !== color) { g.drawOffer = null; emit(opp, 'drawdeclined', { gameId: g.id }); return send(res, 200, { ok: true }), true; }
      return fail(res, 400, 'No draw offer to answer.'), true;
    }
    return false;
  }

  return { handle, openStream, tick, TCS, stats: () => ({ queue: queue.length, games: games.size }) };
};
module.exports.TCS = TCS;
