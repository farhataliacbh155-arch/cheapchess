'use strict';
const assert = require('node:assert/strict');
const { makeServer } = require('./server.js');

let clock = Date.UTC(2026, 10, 3, 12, 0, 0);
const { server, db, mp } = makeServer({ dbPath: ':memory:', now: () => clock, htmlPath: __filename, abandonMs: 300 });
let passed = 0; const ok = n => { passed++; console.log('  ok  ' + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sq = s => (8 - +s[1]) * 8 + 'abcdefgh'.indexOf(s[0]);

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, json: j };
  };
  const opened = {};
  async function sse(token) {
    const t = (await call('POST', '/api/stream/ticket', {}, token)).json.ticket;
    const ac = new AbortController(), r = await fetch(base + '/api/stream?ticket=' + t, { signal: ac.signal });
    assert.equal(r.status, 200);
    const ev = [], used = {};
    (async () => {
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: (\w+)\ndata: (.*)/.exec(c); if (m) ev.push({ event: m[1], data: JSON.parse(m[2]) }); } } } catch (e) {}
    })();
    const wait = async (name, ms = 3000) => {
      const t0 = Date.now();
      for (;;) {
        const i = ev.findIndex((e, k) => e.event === name && !used[k]);
        if (i >= 0) { used[i] = true; return ev[i].data; }
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + name + ' (got ' + ev.map(e => e.event).join(',') + ')');
        await sleep(10);
      }
    };
    (opened[token] = opened[token] || []).push(ac);
    return { ev, wait, close: () => ac.abort(), ticket: t };
  }
  async function user(name) {
    const r = await call('POST', '/api/register', { username: name, password: 'password1', day: new Date(clock).toISOString().slice(0, 10) });
    return { token: r.json.token, name };
  }
  async function pair(a, b, tc = '5+0') {
    const sa = await sse(a.token), sb = await sse(b.token);
    await sa.wait('hello'); await sb.wait('hello');
    let r = await call('POST', '/api/match/find', { tc }, a.token); assert.equal(r.json.queued, true);
    r = await call('POST', '/api/match/find', { tc }, b.token); assert.ok(r.json.game);
    const ma = (await sa.wait('matched')).game, mb = (await sb.wait('matched')).game;
    return { sa, sb, ma, mb, id: ma.id };
  }
  const A = await user('Alice'), B = await user('Bob'), C = await user('Cara');

  /* --- validation --- */
  let r = await call('POST', '/api/match/find', { tc: '5+0' }, A.token); assert.equal(r.status, 409);   // no stream yet
  r = await call('POST', '/api/stream/ticket', {}, null); assert.equal(r.status, 401);
  const bad = await fetch(base + '/api/stream?ticket=nope'); assert.equal(bad.status, 401);
  ok('stream needs a valid one-time ticket; match needs a live connection');

  /* --- matchmaking + full game --- */
  const { sa, sb, ma, mb, id } = await pair(A, B);
  assert.equal(ma.id, mb.id); assert.notEqual(ma.you, mb.you);
  assert.equal(ma.white.rating, 1200); assert.equal(ma.base, 300000);
  const W = ma.you === 'w' ? { tok: A.token, s: sa } : { tok: B.token, s: sb };
  const Bk = ma.you === 'w' ? { tok: B.token, s: sb } : { tok: A.token, s: sa };
  ok('two players searching are matched, with opposite colours');

  const mv = (who, f, t, promo) => call('POST', `/api/game/${id}/move`, { from: sq(f), to: sq(t), promo: promo || '' }, who.tok);
  r = await mv(Bk, 'e7', 'e5'); assert.equal(r.status, 409);                       // not your turn
  r = await mv(W, 'e2', 'e5'); assert.equal(r.status, 400);                         // illegal
  r = await call('POST', `/api/game/${id}/move`, { from: sq('e2'), to: sq('e4') }, C.token); assert.ok([403, 404].includes(r.status));                                         // outsider
  r = await mv(W, 'e2', 'e4'); assert.equal(r.status, 200);
  const e1 = await Bk.s.wait('move'); assert.equal(e1.san, 'e4'); assert.equal(e1.ply, 1); assert.equal(e1.turn, 'b');
  await W.s.wait('move');                                                            // the mover gets it too
  for (const [who, f, t] of [[Bk, 'e7', 'e5'], [W, 'f1', 'c4'], [Bk, 'b8', 'c6'], [W, 'd1', 'h5'], [Bk, 'g8', 'f6']]) { r = await mv(who, f, t); assert.equal(r.status, 200); }
  r = await call('GET', '/api/game/current', null, W.tok); assert.equal(r.json.game.moves.length, 6); assert.equal(r.json.game.status, 'playing');
  r = await mv(W, 'h5', 'f7'); assert.equal(r.status, 200);
  const end = await Bk.s.wait('end'); assert.equal(end.result, '1-0'); assert.equal(end.reason, 'checkmate');
  assert.equal(end.ratings.w.after, 1216); assert.equal(end.ratings.b.after, 1184);
  ok('scholar’s mate: moves relayed, illegal / out-of-turn rejected, checkmate ends the game');
  r = await call('GET', '/api/game/current', null, Bk.tok); assert.equal(r.json.game.status, 'ended'); assert.equal(r.json.game.result, '1-0');
  r = await mv(W, 'a2', 'a3'); assert.equal(r.status, 404);
  ok('finished game is still readable, no more moves accepted');
  const me = (await call('GET', '/api/me', null, W.tok)).json.user; assert.equal(me.rating, 1216); assert.equal(me.wins, 1);
  const them = (await call('GET', '/api/me', null, Bk.tok)).json.user; assert.equal(them.rating, 1184); assert.equal(them.losses, 1);
  ok('ratings and win/loss record updated');
  r = await call('GET', '/api/history', null, Bk.tok);
  assert.equal(r.json.games.length, 1); assert.equal(r.json.games[0].outcome, 'loss'); assert.equal(r.json.games[0].moves.length, 7); assert.equal(r.json.games[0].ratingAfter, 1184);
  ok('game history saved');

  /* --- resign, draw, queue cancel --- */
  let p = await pair(A, B, 'inf');
  const wA = p.ma.you === 'w';
  const first = wA ? A : B, second = wA ? B : A, sFirst = wA ? p.sa : p.sb, sSecond = wA ? p.sb : p.sa;
  const m2 = (who, f, t) => call('POST', `/api/game/${p.id}/move`, { from: sq(f), to: sq(t) }, who.token);
  await m2(first, 'd2', 'd4'); await m2(second, 'd7', 'd5');
  r = await call('POST', `/api/game/${p.id}/draw`, { action: 'offer' }, first.token); assert.equal(r.status, 200);
  assert.equal((await sSecond.wait('draw')).from, 'w');
  r = await call('POST', `/api/game/${p.id}/draw`, { action: 'decline' }, second.token); assert.equal(r.status, 200);
  await sFirst.wait('drawdeclined');
  r = await call('POST', `/api/game/${p.id}/draw`, { action: 'offer' }, first.token);
  r = await call('POST', `/api/game/${p.id}/draw`, { action: 'accept' }, first.token); assert.equal(r.status, 400);   // can't accept your own offer
  r = await call('POST', `/api/game/${p.id}/draw`, { action: 'accept' }, second.token); assert.equal(r.status, 200);
  const dr = await sFirst.wait('end'); assert.equal(dr.result, '1/2-1/2'); assert.equal(dr.reason, 'agreement');
  ok('draw offer, decline, accept');

  p = await pair(A, B, '10+0');
  const w2 = p.ma.you === 'w' ? A : B, b2 = w2 === A ? B : A;
  await call('POST', `/api/game/${p.id}/move`, { from: sq('e2'), to: sq('e4') }, w2.token);
  await call('POST', `/api/game/${p.id}/move`, { from: sq('e7'), to: sq('e5') }, b2.token);
  await call('POST', `/api/game/${p.id}/resign`, {}, b2.token);
  const rs = await (w2 === A ? p.sa : p.sb).wait('end'); assert.equal(rs.result, '1-0'); assert.equal(rs.reason, 'resignation');
  ok('resignation');

  p = await pair(A, B, '3+0');
  r = await call('POST', `/api/game/${p.id}/resign`, {}, A.token);
  const ab = await p.sb.wait('end'); assert.equal(ab.aborted, true);               // fewer than 2 moves: no rating change
  ok('very short game counts as aborted (no rating change)');

  const sc = await sse(C.token); await sc.wait('hello');
  r = await call('POST', '/api/match/find', { tc: '5+0' }, C.token); assert.equal(r.json.queued, true);
  r = await call('POST', '/api/match/find', { tc: 'bogus' }, C.token); assert.equal(r.status, 400);
  await call('POST', '/api/match/cancel', {}, C.token);
  const sa2 = await sse(A.token); await sa2.wait('hello');
  r = await call('POST', '/api/match/find', { tc: '5+0' }, A.token); assert.equal(r.json.queued, true);   // C cancelled, so nobody to match
  await call('POST', '/api/match/cancel', {}, A.token);
  ok('queue: cancel works, unknown time control rejected');

  /* --- clock --- */
  p = await pair(B, C, '3+0');
  const wb = p.ma.you === 'w' ? B : C, bb2 = wb === B ? C : B;
  r = await call('POST', `/api/game/${p.id}/move`, { from: sq('e2'), to: sq('e4') }, wb.token);
  clock += 100000;                                                                  // black thinks for 100 s
  r = await call('POST', `/api/game/${p.id}/move`, { from: sq('e7'), to: sq('e5') }, bb2.token); assert.equal(r.status, 200);
  const cur = (await call('GET', '/api/game/current', null, wb.token)).json.game;
  assert.equal(cur.clocks.b, 80000); assert.equal(cur.clocks.w, 180000);            // only the side to move uses time
  clock += 200000; mp.tick();
  const to = (await call('GET', '/api/game/current', null, wb.token)).json.game;
  assert.equal(to.status, 'ended'); assert.equal(to.reason, 'timeout'); assert.equal(to.result, '0-1');
  ok('clocks count down per side; running out of time loses');
  /* --- leaving a game --- */
  p = await pair(A, B, '5+0');
  const wq = p.ma.you === 'w' ? A : B, bq = wq === A ? B : A, sBq = bq === A ? p.sa : p.sb, sWq = wq === A ? p.sa : p.sb;
  await call('POST', `/api/game/${p.id}/move`, { from: sq('e2'), to: sq('e4') }, wq.token);
  await call('POST', `/api/game/${p.id}/move`, { from: sq('e7'), to: sq('e5') }, bq.token);
  (opened[bq.token] || []).forEach(ac => ac.abort());                                // black closes the page
  const dc = await sWq.wait('opponent'); assert.equal(dc.state, 'disconnected');
  const ad = await sWq.wait('end', 3000); assert.equal(ad.reason, 'abandonment'); assert.equal(ad.result, '1-0');
  ok('leaving a game: opponent is told, then wins after the grace period');
  /* --- ratings on the profile --- */
  r = await call('GET', '/api/rankings'); assert.ok(r.json.top.length >= 3);
  assert.deepEqual(r.json.top.map(x => x.rating), [...r.json.top.map(x => x.rating)].sort((a, b) => b - a));      // best first
  const meNow = (await call('GET', '/api/me', null, (await call('POST', '/api/login', { username: 'alice', password: 'password1' })).json.token)).json.user;
  assert.equal(typeof meNow.rank, 'number'); assert.ok(meNow.rank >= 1 && meNow.rank <= meNow.players);
  assert.equal(meNow.rank, 1 + r.json.top.filter(x => x.rating > meNow.rating).length);
  ok('rankings list and each player’s rank');
  server.close(); db.close?.();
  console.log('\nAll ' + passed + ' multiplayer checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
