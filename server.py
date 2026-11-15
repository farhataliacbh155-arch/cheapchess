"""Chess backend: user accounts, SQLite database, in-memory cache, daily login streak, live multiplayer.
Port of server.js. Python 3.9+ standard library only: nothing to install.
Run:  python server.py     then open  http://localhost:3000
The database file format is the same as the Node version, so an existing chess.db keeps working."""
import hashlib, hmac, json, os, re, secrets, signal, sqlite3, sys, threading, time, traceback, unicodedata
from collections import OrderedDict
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from database import Database
from multiplayer import Multiplayer

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWED_KEYS = {"chess_saves", "chess_pz", "chess_learn"}
SESSION_MS = 30 * 24 * 3600 * 1000
MAX_BODY = 2 * 1024 * 1024
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,20}\Z")
AVATARS = ["♞", "♟", "♛", "♚", "♜", "♝", "🦊", "🐼", "🦁", "🐯", "🐸", "🐵", "🦉", "🐙", "🦄", "🐲", "🚀", "⭐", "🔥", "🌙", "🎯", "🧠", "👑", "🎩"]
COLORS = ["#81b64c", "#5c8bb0", "#e0a030", "#d9534f", "#9b59b6", "#e67e9a", "#2bb5a0", "#7f8c8d"]
PRESENCE_TTL = 75 * 1000          # no heartbeat for this long means offline
DUMMY_SALT = "0" * 32


def default_now():
    return int(time.time() * 1000)


def valid_display(s):             # 2-24 letters, numbers, spaces, _ . ' -
    return 2 <= len(s) <= 24 and all(unicodedata.category(c)[0] in "LN" or c in " _.'-" for c in s)


def js_str(v):                    # like String(v || '')
    return v if isinstance(v, str) else ("" if not v else str(v))


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))


# ---------- cache: small TTL + LRU map ----------
class TTLCache:
    def __init__(self, max_items=5000, now=default_now):
        self.m, self.max, self.now = OrderedDict(), max_items, now

    def get(self, k):
        e = self.m.get(k)
        if e is None:
            return None
        if e[1] < self.now():
            del self.m[k]
            return None
        self.m.move_to_end(k)                        # mark as recently used
        return e[0]

    def set(self, k, v, ttl_ms):
        self.m.pop(k, None)
        if len(self.m) >= self.max:
            self.m.popitem(last=False)
        self.m[k] = (v, self.now() + ttl_ms)

    def delete(self, k):
        self.m.pop(k, None)

    def del_prefix(self, p):
        for k in [k for k in self.m if k.startswith(p)]:
            del self.m[k]

    def sweep(self):
        t = self.now()
        for k in [k for k, e in self.m.items() if e[1] < t]:
            del self.m[k]

    def __len__(self):
        return len(self.m)


# ---------- daily streak rules (pure functions) ----------
def day_num(s):
    return (date(int(s[0:4]), int(s[5:7]), int(s[8:10])) - date(1970, 1, 1)).days


def utc_day(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def pick_day(client_day, now_ms):
    """The browser sends its local date so a streak follows the player's own midnight.
    It is only trusted when it is within one day of the server's UTC date (covers every time zone)."""
    utc = utc_day(now_ms)
    if isinstance(client_day, str) and DAY_RE.match(client_day):
        try:
            if abs(day_num(client_day) - day_num(utc)) <= 1:
                return client_day
        except ValueError:
            pass
    return utc


def next_streak(last, today, streak, best):
    if last and day_num(today) <= day_num(last):
        return {"streak": streak, "best": best, "changed": False}
    ns = streak + 1 if last and day_num(today) - day_num(last) == 1 else 1
    return {"streak": ns, "best": max(best, ns), "changed": True}


def live_streak(last, today, streak):
    """Streak to show when the player hasn't logged in today yet: still alive if they logged in yesterday."""
    if not last:
        return 0
    return streak if day_num(today) - day_num(last) <= 1 else 0


class HttpError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


class App:
    def __init__(self, now=None, db_path=None, html_path=None, abandon_ms=None, host="", port=0):
        self.now = now or default_now
        db_path = db_path or os.environ.get("DB_PATH") or os.path.join(HERE, "chess.db")
        self.html_path = html_path or os.environ.get("HTML_PATH") or os.path.join(HERE, "Chess.html")
        self.cors = os.environ.get("CORS_ORIGIN") or "*"
        self.trust_proxy = os.environ.get("TRUST_PROXY") == "1"
        self.lock = threading.RLock()                    # one lock guards the database, caches and live games
        self.cache, self.limits = TTLCache(5000, self.now), TTLCache(20000, self.now)

        db = self.db = Database(db_path=db_path)
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users(
              id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display TEXT NOT NULL,
              salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_date TEXT,
              streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, total_days INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sessions(
              token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS kv(
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL, v TEXT NOT NULL,
              updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,k)
            );
            CREATE TABLE IF NOT EXISTS login_days(
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, PRIMARY KEY(user_id,day)
            );
        """)
        cols = db.user_columns()
        for n, d in (("avatar", "TEXT NOT NULL DEFAULT '♞'"), ("color", "TEXT NOT NULL DEFAULT '#81b64c'"),
                     ("bio", "TEXT NOT NULL DEFAULT ''"), ("presence", "TEXT NOT NULL DEFAULT 'offline'"),
                     ("last_seen", "INTEGER NOT NULL DEFAULT 0"), ("rating", "INTEGER NOT NULL DEFAULT 1200"),
                     ("wins", "INTEGER NOT NULL DEFAULT 0"), ("losses", "INTEGER NOT NULL DEFAULT 0"),
                     ("draws", "INTEGER NOT NULL DEFAULT 0")):
            if n not in cols:
                db.execute("ALTER TABLE users ADD COLUMN " + n + " " + d)

        self.mp = Multiplayer(db, self.now, self.lock, self.send, self.fail, self.cors, abandon_ms)
        # Widen legacy PostgreSQL timestamp columns after every table exists.
        # This also repairs databases created by earlier INTEGER-based builds.
        db.migrate_timestamp_columns()
        app = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            timeout = 65
            def log_message(self, *a): pass
            def do_GET(self): app.dispatch(self)
            do_POST = do_PUT = do_DELETE = do_OPTIONS = do_GET
            def json(self):
                if self._body is None:
                    if not self.raw: self._body = {}
                    else:
                        try: self._body = json.loads(self.raw.decode("utf-8"))
                        except ValueError: raise HttpError(400, "bad json")
                        if not isinstance(self._body, dict): raise HttpError(400, "bad json")
                return self._body

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            request_queue_size = 128
            allow_reuse_address = True

        self.httpd = Server((host, port), Handler)
        self.port = self.httpd.server_address[1]
        self._thread = None
        self._janitor = threading.Timer(3600, self._sweep)
        self._janitor.daemon = True
        self._janitor.start()

    # ---------- lifecycle ----------
    def _sweep(self):
        try:
            with self.lock:
                self.db.execute("DELETE FROM sessions WHERE expires_at<?", (self.now(),))
                self.cache.sweep(); self.limits.sweep()
        except Exception:
            pass
        self._janitor = threading.Timer(3600, self._sweep); self._janitor.daemon = True; self._janitor.start()

    def start(self):
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self):
        self._janitor.cancel()
        self.mp.shutdown()
        self.httpd.shutdown(); self.httpd.server_close()
        with self.lock:
            try: self.db.close()
            except Exception: pass

    # ---------- responses ----------
    def _headers(self, h, status, extra=None):
        h.send_response(status)
        h.send_header("Access-Control-Allow-Origin", self.cors)
        h.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        h.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        for k, v in (extra or {}).items(): h.send_header(k, v)

    def send(self, h, status, obj, extra=None):
        body = b"" if status == 204 else dumps(obj).encode("utf-8")
        self._headers(h, status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                                  "X-Content-Type-Options": "nosniff", "Content-Length": str(len(body)), **(extra or {})})
        h.end_headers()
        if body: h.wfile.write(body)
        h._sent = True

    def fail(self, h, status, msg):
        self.send(h, status, {"error": msg})

    # ---------- helpers ----------
    @staticmethod
    def sha(s): return hashlib.sha256(s.encode()).hexdigest()

    @staticmethod
    def hash_pw(pw, salt):          # same scrypt settings as Node's crypto.scrypt(pw, salt, 64), so old accounts still log in
        return hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024).hex()

    def check_pw(self, pw, u):
        return hmac.compare_digest(self.hash_pw(pw, u["salt"]).encode(), u["hash"].encode())

    def hit(self, key, limit, window_ms):
        e = self.limits.get(key) or {"n": 0, "reset": self.now() + window_ms}
        e["n"] += 1
        self.limits.set(key, e, max(1, e["reset"] - self.now()))
        return e["n"] <= limit

    def user_by_id(self, uid): return self.db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    def user_by_name(self, k): return self.db.execute("SELECT * FROM users WHERE username=?", (k,)).fetchone()

    def new_session(self, uid):
        token = secrets.token_urlsafe(32)
        self.db.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                        (self.sha(token), uid, self.now(), self.now() + SESSION_MS))
        return token

    def auth(self, h):
        m = re.match(r"^Bearer (.+)\Z", h.headers.get("Authorization") or "")
        if not m: return None
        th = self.sha(m.group(1))
        s = self.cache.get("sess:" + th)
        if s is None:
            r = self.db.execute("SELECT s.user_id,s.expires_at,u.username,u.display FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", (th,)).fetchone()
            s = dict(r) if r else False
            self.cache.set("sess:" + th, s, 60000)
        if not s: return None
        if s["expires_at"] < self.now():
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (th,)); self.cache.delete("sess:" + th)
            return None
        return {"userId": s["user_id"], "username": s["username"], "display": s["display"], "th": th}

    def streak_info(self, uid, day):
        u, today = self.user_by_id(uid), pick_day(day, self.now())
        return {"streak": live_streak(u["last_login_date"], today, u["streak"]), "best": u["best_streak"],
                "lastDay": u["last_login_date"], "today": today, "totalDays": u["total_days"],
                "checkedInToday": u["last_login_date"] == today,
                "recentDays": [r["day"] for r in self.db.execute("SELECT day FROM login_days WHERE user_id=? ORDER BY day DESC LIMIT 30", (uid,))]}

    def checkin(self, uid, day):
        today = pick_day(day, self.now())
        self.db.execute("BEGIN IMMEDIATE")
        try:
            u = self.user_by_id(uid)
            r = next_streak(u["last_login_date"], today, u["streak"], u["best_streak"])
            if r["changed"]:
                self.db.execute("UPDATE users SET last_login_date=?,streak=?,best_streak=?,total_days=total_days+1 WHERE id=?", (today, r["streak"], r["best"], uid))
                self.db.execute("INSERT OR IGNORE INTO login_days(user_id,day) VALUES(?,?)", (uid, today))
                self.cache.delete("board")
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK"); raise
        self.set_status(uid, "online")
        return {**self.streak_info(uid, today), "changed": r["changed"]}

    def status_of(self, u):
        return u["presence"] if (u["presence"] != "offline" and self.now() - u["last_seen"] <= PRESENCE_TTL) else "offline"

    def public_user(self, u):
        return {"name": u["display"], "key": u["username"], "avatar": u["avatar"], "color": u["color"], "bio": u["bio"],
                "status": self.status_of(u), "rating": u["rating"], "wins": u["wins"], "losses": u["losses"], "draws": u["draws"],
                "rank": self.db.execute("SELECT COUNT(*)+1 AS n FROM users WHERE rating>?", (u["rating"],)).fetchone()["n"],
                "players": self.db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], "since": u["created_at"]}

    def set_status(self, uid, state):
        self.db.execute("UPDATE users SET presence=?,last_seen=? WHERE id=?", (state, 0 if state == "offline" else self.now(), uid))
        self.cache.delete("players")

    def ip(self, h):
        if self.trust_proxy and h.headers.get("X-Forwarded-For"):
            hops = [x.strip() for x in h.headers["X-Forwarded-For"].split(",") if x.strip()]
            if hops: return hops[-1]            # the LAST hop is what the trusted proxy itself saw; earlier ones can be forged
        return h.client_address[0] or "?"

    # ---------- request handling ----------
    def dispatch(self, h):
        h._body, h._sent, h.raw = None, False, b""
        try:
            try: n = int(h.headers.get("Content-Length") or 0)
            except ValueError: raise HttpError(400, "bad length")
            if n > MAX_BODY:
                h.close_connection = True
                raise HttpError(413, "too large")
            if n > 0: h.raw = h.rfile.read(n)
            if h.headers.get("Transfer-Encoding"): h.close_connection = True
            self.handle(h)
        except HttpError as e:
            if not h._sent: self.fail(h, e.status, e.msg)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            h.close_connection = True
        except Exception:
            traceback.print_exc()
            h.close_connection = True
            if not h._sent:
                try: self.fail(h, 500, "Server error")
                except OSError: pass

    def handle(self, h):
        u = urlsplit(h.path); p, qs, m = u.path, parse_qs(u.query), h.command
        now, L, db = self.now, self.lock, self.db
        if m == "OPTIONS":
            return self.send(h, 204, {})
        if m == "GET" and p in ("/", "/Chess.html"):
            with L:
                html = self.cache.get("html")
                if html is None:
                    try:
                        with open(self.html_path, "rb") as f: html = f.read()
                    except OSError:
                        return self.fail(h, 404, "Chess.html not found next to server.py")
                    self.cache.set("html", html, 5000)
            self._headers(h, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
                                   "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
                                   "Content-Length": str(len(html))})
            h.end_headers(); h.wfile.write(html); h._sent = True
            return
        if not p.startswith("/api/"):
            return self.fail(h, 404, "Not found")
        if m == "GET" and p == "/api/health":
            return self.send(h, 200, {"ok": True, "time": now()})

        if m == "GET" and p == "/api/leaderboard":
            with L:
                b = self.cache.get("board")
                if b is None:
                    b = [{"name": r["display"], "avatar": r["avatar"], "color": r["color"], "status": self.status_of(r),
                          "streak": live_streak(r["last_login_date"], utc_day(now()), r["streak"]), "best": r["best_streak"]}
                         for r in self.db.execute("SELECT display,avatar,color,presence,last_seen,streak,best_streak,last_login_date FROM users ORDER BY best_streak DESC, streak DESC LIMIT 10")]
                    self.cache.set("board", b, 15000)
            return self.send(h, 200, {"top": b})

        if m == "GET" and p == "/api/rankings":
            with L:
                r = self.cache.get("rankings")
                if r is None:
                    r = [{"pos": i + 1, "name": x["display"], "avatar": x["avatar"], "color": x["color"], "status": self.status_of(x),
                          "rating": x["rating"], "wins": x["wins"], "losses": x["losses"], "draws": x["draws"]}
                         for i, x in enumerate(self.db.execute("SELECT display,avatar,color,presence,last_seen,rating,wins,losses,draws FROM users ORDER BY rating DESC, wins DESC, id ASC LIMIT 10"))]
                    self.cache.set("rankings", r, 15000)
            return self.send(h, 200, {"top": r})

        if m == "GET" and p == "/api/players":
            with L:
                lst = self.cache.get("players")
                if lst is None:
                    order = {"online": 0, "idle": 1, "offline": 2}
                    lst = [{"name": r["display"], "avatar": r["avatar"], "color": r["color"], "status": self.status_of(r), "rating": r["rating"],
                            "streak": live_streak(r["last_login_date"], utc_day(now()), r["streak"])}
                           for r in self.db.execute("SELECT display,avatar,color,presence,last_seen,streak,last_login_date,rating FROM users ORDER BY last_seen DESC LIMIT 60")]
                    lst = sorted(lst, key=lambda x: order[x["status"]])[:20]
                    self.cache.set("players", lst, 8000)
            return self.send(h, 200, {"players": lst})

        if m == "POST" and p in ("/api/register", "/api/login"):
            with L: allowed = self.hit("ip:" + self.ip(h), 30, 10 * 60000)
            if not allowed: return self.fail(h, 429, "Too many attempts. Try again in a few minutes.")
            body = h.json()
            name, pw = js_str(body.get("username")).strip(), js_str(body.get("password"))
            key = name.lower()
            if not NAME_RE.match(name): return self.fail(h, 400, "Username: 3–20 letters, numbers, _ . or -")
            if len(pw) < 6 or len(pw) > 128: return self.fail(h, 400, "Password must be 6–128 characters.")
            if key == "guest": return self.fail(h, 400, "That username is reserved.")
            if p == "/api/register":
                with L:
                    if self.user_by_name(key): return self.fail(h, 409, "That username is taken.")
                salt = secrets.token_hex(16)
                hashed = self.hash_pw(pw, salt)                               # slow: done outside the lock
                with L:
                    try:
                        sql = "INSERT INTO users(username,display,salt,hash,created_at) VALUES(?,?,?,?,?)"
                        if db.is_postgres:
                            sql += " RETURNING id"
                        cur = self.db.execute(sql, (key, name, salt, hashed, now()))
                    except db.integrity_error:
                        return self.fail(h, 409, "That username is taken.")
                    uid = cur.fetchone()["id"] if db.is_postgres else cur.lastrowid
            else:
                with L:
                    fails = self.limits.get("fail:" + key)
                    if fails and fails["n"] >= 8: return self.fail(h, 429, "Too many wrong passwords for this account. Try again in 10 minutes.")
                    user = self.user_by_name(key)
                good = self.check_pw(pw, user) if user else (self.hash_pw(pw, DUMMY_SALT) and False)   # same work either way, so timing doesn't reveal which names exist
                with L:
                    if not good:
                        self.hit("fail:" + key, 1e9, 10 * 60000)
                        return self.fail(h, 401, "Wrong username or password.")
                    self.limits.delete("fail:" + key)
                uid = user["id"]
            with L:
                token = self.new_session(uid)
                streak = self.checkin(uid, body.get("day"))
                out = {"token": token, "user": self.public_user(self.user_by_id(uid)), "streak": streak}
            return self.send(h, 201 if p == "/api/register" else 200, out)

        if m == "GET" and p == "/api/stream":
            return self.mp.open_stream(h, qs)

        # ----- everything below needs a session -----
        with L: a = self.auth(h)
        if not a: return self.fail(h, 401, "Please sign in.")
        with L:
            if self.mp.handle(h, p, qs, a): return

            if m == "POST" and p == "/api/logout":
                self.db.execute("DELETE FROM sessions WHERE token_hash=?", (a["th"],)); self.cache.delete("sess:" + a["th"])
                self.set_status(a["userId"], "offline")
                return self.send(h, 200, {"ok": True})
            if m == "GET" and p == "/api/me":
                return self.send(h, 200, {"user": self.public_user(self.user_by_id(a["userId"])),
                                          "streak": self.streak_info(a["userId"], (qs.get("day") or [None])[0])})
            if m == "POST" and p == "/api/checkin":
                st = self.checkin(a["userId"], h.json().get("day"))
                return self.send(h, 200, {"streak": st, "user": self.public_user(self.user_by_id(a["userId"]))})
            if m == "POST" and p == "/api/presence":
                state = h.json().get("state")
                if state not in ("online", "idle"): return self.fail(h, 400, "state must be online or idle")
                self.set_status(a["userId"], state)
                return self.send(h, 200, {"status": state})
            if m == "PUT" and p == "/api/profile":
                body, u = h.json(), self.user_by_id(a["userId"])
                display, avatar, color, bio = u["display"], u["avatar"], u["color"], u["bio"]
                if "display" in body:
                    display = re.sub(r"\s+", " ", js_str(body["display"]).strip())
                    if not valid_display(display): return self.fail(h, 400, "Display name: 2–24 letters, numbers, spaces, _ . - or '")
                if "avatar" in body:
                    if body["avatar"] not in AVATARS: return self.fail(h, 400, "Pick an avatar from the list.")
                    avatar = body["avatar"]
                if "color" in body:
                    if body["color"] not in COLORS: return self.fail(h, 400, "Pick a colour from the list.")
                    color = body["color"]
                if "bio" in body:
                    bio = re.sub(r"[\u0000-\u001f<>&]", "", js_str(body["bio"])).strip()
                    if len(bio) > 80: return self.fail(h, 400, "About you can be at most 80 characters.")
                self.db.execute("UPDATE users SET display=?,avatar=?,color=?,bio=? WHERE id=?", (display, avatar, color, bio, a["userId"]))
                self.cache.delete("board"); self.cache.delete("players")
                return self.send(h, 200, {"user": self.public_user(self.user_by_id(a["userId"]))})
            if m == "POST" and p == "/api/password":
                if not self.hit("pw:%d" % a["userId"], 10, 10 * 60000): return self.fail(h, 429, "Too many attempts. Try again in a few minutes.")
                body, u = h.json(), self.user_by_id(a["userId"])
                old_pw, new_pw = js_str(body.get("oldPassword")), js_str(body.get("newPassword"))
                self.lock.release()                                    # scrypt is slow: don't hold up every other request
                try:
                    old_ok = self.check_pw(old_pw, u)
                    salt = secrets.token_hex(16)
                    new_hash = self.hash_pw(new_pw, salt) if old_ok and 6 <= len(new_pw) <= 128 else None
                finally:
                    self.lock.acquire()
                if not old_ok: return self.fail(h, 401, "Your current password is wrong.")
                if new_hash is None: return self.fail(h, 400, "New password must be 6–128 characters.")
                self.db.execute("UPDATE users SET salt=?,hash=? WHERE id=?", (salt, new_hash, a["userId"]))
                self.db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (a["userId"], a["th"]))   # sign out every other device
                self.cache.del_prefix("sess:")
                return self.send(h, 200, {"ok": True})
            if m == "GET" and p == "/api/store":
                allv = self.cache.get("kv:%d" % a["userId"])
                if allv is None:
                    allv = {r["k"]: {"raw": r["v"], "updated_at": r["updated_at"]}
                            for r in self.db.execute("SELECT k,v,updated_at FROM kv WHERE user_id=?", (a["userId"],))}
                    self.cache.set("kv:%d" % a["userId"], allv, 5 * 60000)
                return self.send(h, 200, {k: {"value": json.loads(v["raw"]), "updated_at": v["updated_at"]} for k, v in allv.items()})
            sm = re.match(r"^/api/store/([A-Za-z0-9_]+)\Z", p)
            if sm:
                key = sm.group(1)
                if key not in ALLOWED_KEYS: return self.fail(h, 400, "Unknown data key.")
                if m == "PUT":
                    body = h.json()
                    if "value" not in body: return self.fail(h, 400, "Missing value.")
                    raw = dumps(body["value"])
                    if len(raw) > MAX_BODY: return self.fail(h, 413, "Value too large.")
                    t = now()
                    self.db.execute("INSERT INTO kv(user_id,k,v,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at", (a["userId"], key, raw, t))
                    self.cache.delete("kv:%d" % a["userId"])                    # invalidate on write
                    return self.send(h, 200, {"updated_at": t})
                if m == "DELETE":
                    self.db.execute("DELETE FROM kv WHERE user_id=? AND k=?", (a["userId"], key)); self.cache.delete("kv:%d" % a["userId"])
                    return self.send(h, 200, {"ok": True})
            return self.fail(h, 404, "Not found")


def make_server(**kw):
    return App(**kw)


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or 3000)
    app = make_server(port=port)
    print("Chess server running on http://localhost:%d" % port, flush=True)
    def _stop():
        app.mp.shutdown(); app.httpd.shutdown()                # running games are already saved; they resume when the server starts again
    stop = lambda *_: threading.Thread(target=_stop, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    app.httpd.serve_forever()
