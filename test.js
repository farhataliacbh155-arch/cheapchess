'use strict';
const assert = require('node:assert/strict');
const { makeServer, TTLCache, pickDay, nextStreak, liveStreak } = require('./server.js');

let clock = Date.UTC(2026, 10, 3, 12, 0, 0);          // 3 Nov 2026, midday UTC
const DAY = 86400000;
const { server, db } = makeServer({ dbPath: ':memory:', now: () => clock, htmlPath: __filename });
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

(async () => {
  /* --- pure rules --- */
  assert.deepEqual(nextStreak(null, '2026-11-03', 0, 0), { streak: 1, best: 1, changed: true });
  assert.deepEqual(nextStreak('2026-11-03', '2026-11-04', 1, 1), { streak: 2, best: 2, changed: true });
  assert.deepEqual(nextStreak('2026-11-04', '2026-11-04', 2, 2), { streak: 2, best: 2, changed: false });
  assert.deepEqual(nextStreak('2026-11-04', '2026-11-07', 2, 5), { streak: 1, best: 5, changed: true });
  assert.deepEqual(nextStreak('2026-11-10', '2026-11-09', 4, 4), { streak: 4, best: 4, changed: false });
  assert.deepEqual(nextStreak('2026-02-28', '2026-03-01', 3, 3), { streak: 4, best: 4, changed: true });   // month rollover
  assert.deepEqual(nextStreak('2026-12-31', '2027-01-01', 3, 3), { streak: 4, best: 4, changed: true });   // year rollover
  assert.equal(liveStreak('2026-11-02', '2026-11-03', 5), 5);
  assert.equal(liveStreak('2026-11-01', '2026-11-03', 5), 0);
  ok('streak rules');
  const t = Date.UTC(2026, 10, 3, 23, 30);
  assert.equal(pickDay('2026-11-04', t), '2026-11-04');   // player already past midnight
  assert.equal(pickDay('2026-11-02', t), '2026-11-02');
  assert.equal(pickDay('2026-12-25', t), '2026-11-03');   // too far from server date, ignored
  assert.equal(pickDay('nope', t), '2026-11-03');
  ok('client date handling');
  const c = new TTLCache(2, () => clock);
  c.set('a', 1, 1000); c.set('b', 2, 1000); c.get('a'); c.set('c', 3, 1000);
  assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1);
  clock += 2000; assert.equal(c.get('a'), undefined);
  clock -= 2000;
  ok('cache (LRU + expiry)');

  /* --- HTTP --- */
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, json: j };
  };
  const today = () => new Date(clock).toISOString().slice(0, 10);

  let r = await call('POST', '/api/register', { username: 'ab', password: 'secret1' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/register', { username: 'Alice', password: '123' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/register', { username: 'guest', password: 'secret1' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/register', { username: 'Alice', password: 'secret1', day: today() });
  assert.equal(r.status, 201); assert.equal(r.json.streak.streak, 1); assert.equal(r.json.user.name, 'Alice');
  const tok1 = r.json.token;
  r = await call('POST', '/api/register', { username: 'ALICE', password: 'secret1' });
  assert.equal(r.status, 409);
  ok('register + validation + duplicate name');

  r = await call('POST', '/api/login', { username: 'alice', password: 'wrong!!' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'alice', password: 'secret1', day: today() });
  assert.equal(r.status, 200); assert.equal(r.json.streak.streak, 1); assert.equal(r.json.streak.changed, false);
  const tok = r.json.token;
  ok('login (wrong password rejected, same-day login does not double count)');

  r = await call('GET', '/api/me'); assert.equal(r.status, 401);
  r = await call('GET', '/api/me?day=' + today(), null, tok); assert.equal(r.status, 200); assert.equal(r.json.user.name, 'Alice');
  ok('session required');

  for (let d = 2; d <= 5; d++) {
    clock += DAY;
    r = await call('POST', '/api/checkin', { day: today() }, tok);
    assert.equal(r.json.streak.streak, d); assert.equal(r.json.streak.changed, true);
    r = await call('POST', '/api/checkin', { day: today() }, tok);
    assert.equal(r.json.streak.streak, d); assert.equal(r.json.streak.changed, false);
  }
  ok('5-day streak builds one day at a time');

  clock += 3 * DAY;                                         // skip days
  r = await call('GET', '/api/me?day=' + today(), null, tok);
  assert.equal(r.json.streak.streak, 0); assert.equal(r.json.streak.best, 5);
  r = await call('POST', '/api/checkin', { day: today() }, tok);
  assert.equal(r.json.streak.streak, 1); assert.equal(r.json.streak.best, 5); assert.equal(r.json.streak.totalDays, 6);
  ok('missed days reset the streak, best streak is kept');

  r = await call('PUT', '/api/store/chess_saves', { value: [{ id: 1, name: 'Game A' }] }, tok);
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/store/chess_pz', { value: { solved: 7 } }, tok); assert.equal(r.status, 200);
  r = await call('PUT', '/api/store/evil_key', { value: 1 }, tok); assert.equal(r.status, 400);
  r = await call('GET', '/api/store', null, tok);
  assert.deepEqual(r.json.chess_saves.value, [{ id: 1, name: 'Game A' }]); assert.equal(r.json.chess_pz.value.solved, 7);
  const cached = r.json;
  r = await call('GET', '/api/store', null, tok); assert.deepEqual(r.json, cached);        // served from cache
  r = await call('PUT', '/api/store/chess_pz', { value: { solved: 8 } }, tok);
  r = await call('GET', '/api/store', null, tok); assert.equal(r.json.chess_pz.value.solved, 8);   // cache invalidated by write
  ok('database store, cache hit, cache invalidation on write');

  r = await call('POST', '/api/register', { username: 'Bob', password: 'hunter22', day: today() });
  const bobTok = r.json.token;
  r = await call('GET', '/api/store', null, bobTok); assert.deepEqual(r.json, {});
  r = await call('PUT', '/api/store/chess_saves', { value: [] }, bobTok);
  r = await call('GET', '/api/store', null, tok); assert.equal(r.json.chess_saves.value.length, 1);
  ok('each user only sees their own data');

  r = await call('GET', '/api/leaderboard'); assert.equal(r.json.top[0].name, 'Alice'); assert.equal(r.json.top[0].best, 5);
  ok('leaderboard');

  r = await call('POST', '/api/logout', {}, tok); assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, tok); assert.equal(r.status, 401);
  r = await call('GET', '/api/me', null, tok1); assert.equal(r.status, 200);   // the registration session is separate and still valid
  ok('logout kills only that session');

  clock += 31 * DAY;
  r = await call('GET', '/api/me', null, tok1); assert.equal(r.status, 401);
  ok('sessions expire after 30 days');

  for (let i = 0; i < 8; i++) await call('POST', '/api/login', { username: 'bob', password: 'bad-pass' });
  r = await call('POST', '/api/login', { username: 'bob', password: 'hunter22' });
  assert.equal(r.status, 429);
  ok('too many wrong passwords locks the account for a while');

  /* --- profile, password, status --- */
  r = await call('POST', '/api/register', { username: 'Carol', password: 'carolpw1', day: today() });
  assert.equal(r.status, 201); const ct = r.json.token;
  assert.equal(r.json.user.avatar, '♞'); assert.equal(r.json.user.status, 'online');
  r = await call('PUT', '/api/profile', { display: 'Carol the Great', avatar: '🦊', color: '#5c8bb0', bio: 'I love <endgames>' }, ct);
  assert.equal(r.status, 200); assert.equal(r.json.user.name, 'Carol the Great'); assert.equal(r.json.user.avatar, '🦊'); assert.equal(r.json.user.bio, 'I love endgames');
  assert.equal(r.json.user.key, 'carol');                                   // the login name never changes
  r = await call('PUT', '/api/profile', { display: 'x' }, ct); assert.equal(r.status, 400);
  r = await call('PUT', '/api/profile', { display: '<b>hi</b>' }, ct); assert.equal(r.status, 400);
  r = await call('PUT', '/api/profile', { avatar: 'not-an-emoji' }, ct); assert.equal(r.status, 400);
  r = await call('PUT', '/api/profile', { color: 'red' }, ct); assert.equal(r.status, 400);
  r = await call('PUT', '/api/profile', { bio: 'y'.repeat(81) }, ct); assert.equal(r.status, 400);
  r = await call('GET', '/api/me?day=' + today(), null, ct); assert.equal(r.json.user.name, 'Carol the Great');
  ok('edit profile (name, avatar, colour, about) with validation');

  r = await call('POST', '/api/password', { oldPassword: 'wrongpw', newPassword: 'newpass99' }, ct); assert.equal(r.status, 401);
  r = await call('POST', '/api/password', { oldPassword: 'carolpw1', newPassword: '123' }, ct); assert.equal(r.status, 400);
  const second = (await call('POST', '/api/login', { username: 'carol', password: 'carolpw1' })).json.token;
  r = await call('POST', '/api/password', { oldPassword: 'carolpw1', newPassword: 'newpass99' }, ct); assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, second); assert.equal(r.status, 401);        // other devices signed out
  r = await call('GET', '/api/me', null, ct); assert.equal(r.status, 200);            // this one stays
  r = await call('POST', '/api/login', { username: 'carol', password: 'carolpw1' }); assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'carol', password: 'newpass99' }); assert.equal(r.status, 200);
  ok('change password (old one stops working, other devices signed out)');

  r = await call('GET', '/api/players'); const carol = () => r.json.players.find(p => p.name === 'Carol the Great');
  assert.equal(carol().status, 'online');
  r = await call('POST', '/api/presence', { state: 'idle' }, ct); assert.equal(r.status, 200);
  clock += 10000; r = await call('GET', '/api/players'); assert.equal(carol().status, 'idle');
  r = await call('POST', '/api/presence', { state: 'busy' }, ct); assert.equal(r.status, 400);
  r = await call('POST', '/api/presence', { state: 'online' }, ct);
  clock += 10000; r = await call('GET', '/api/players'); assert.equal(carol().status, 'online');
  clock += 80000; r = await call('GET', '/api/players'); assert.equal(carol().status, 'offline');   // no heartbeat for 75s+
  r = await call('POST', '/api/presence', { state: 'online' }, ct);
  clock += 10000; r = await call('GET', '/api/players'); assert.equal(carol().status, 'online');
  r = await call('POST', '/api/logout', {}, ct);
  clock += 10000; r = await call('GET', '/api/players'); assert.equal(carol().status, 'offline');
  assert.equal(r.json.players[0].status !== 'offline' || r.json.players.every(p => p.status === 'offline'), true);   // online people are listed first
  ok('status: online, idle, offline (heartbeat timeout), logout');

  r = await call('GET', '/api/health'); assert.equal(r.json.ok, true);
  server.close(); db.close?.();
  console.log('\nAll ' + passed + ' checks passed.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
