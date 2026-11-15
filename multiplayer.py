"""Online multiplayer: matchmaking queue, live games, clocks, resign / draw, ratings and history.
Port of multiplayer.js. The server checks every move with the same rules as the page (engine.py) and decides the result.
Players get live updates over Server-Sent Events (GET /api/stream)."""
import json, math, queue, re, secrets, select, socket, threading, time

import engine as E

TCS = {
    "inf":   {"base": 0,      "inc": 0,     "label": "Unlimited"},
    "3+0":   {"base": 180000, "inc": 0,     "label": "3 min"},
    "5+0":   {"base": 300000, "inc": 0,     "label": "5 min"},
    "10+0":  {"base": 600000, "inc": 0,     "label": "10 min"},
    "15+10": {"base": 900000, "inc": 10000, "label": "15 | 10"},
}
K = 32
GAME_ROUTE = re.compile(r"^/api/game/([0-9a-f]{12})/(move|resign|draw)\Z")


def js_round(x):                       # JavaScript's Math.round (halves go up), not Python's banker's rounding
    return math.floor(x + 0.5)


def num(v):                            # like JS  +value  for the numbers we expect; anything odd never matches a move
    try:
        f = float(v)
        return int(f) if f == int(f) else None
    except (TypeError, ValueError, OverflowError):
        return None


MAX_STREAMS = 5                        # open live connections allowed per player


class Stream:
    def __init__(self):
        self.q = queue.Queue()
        self.t0 = time.monotonic()


class Multiplayer:
    def __init__(self, db, now, lock, send, fail, cors_origin="*", abandon_ms=60000):
        self.db, self.now, self.lock, self.send, self.fail = db, now, lock, send, fail
        self.cors, self.abandon_ms = cors_origin, abandon_ms or 60000
        db.executescript("""
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
            CREATE TABLE IF NOT EXISTS live_games(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        """)
        self.queue = []                # [{userId, tc}]
        self.games = {}                # id -> game (playing)
        self.user_game = {}            # userId -> game id
        self.last_ended = {}           # userId -> final snapshot (kept for a while)
        self.streams = {}              # userId -> set(Stream)
        self.tickets = {}              # one-time stream tickets
        self.disc_timers = {}          # userId -> Timer
        self.closing = False
        self.restore()

    # ---------- live events ----------
    def has_stream(self, uid):
        return len(self.streams.get(uid, ())) > 0

    def emit(self, uid, event, data):
        msg = "event: " + event + "\ndata: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n\n"
        for st in list(self.streams.get(uid, ())):
            st.q.put(msg)

    def both(self, g, event, data):
        self.emit(g["white"]["userId"], event, data)
        self.emit(g["black"]["userId"], event, data)

    # ---------- game helpers ----------
    def player(self, uid):
        u = self.db.execute("SELECT id,display,avatar,color,rating,wins,losses,draws FROM users WHERE id=?", (uid,)).fetchone()
        return {"userId": uid, "name": u["display"], "avatar": u["avatar"], "color": u["color"], "rating": u["rating"]}

    @staticmethod
    def pub(p):
        return {"name": p["name"], "avatar": p["avatar"], "color": p["color"], "rating": p["rating"]}

    def clocks_now(self, g):
        if not g["base"]:
            return None
        c = {"w": g["clock"]["w"], "b": g["clock"]["b"]}
        if g["status"] == "playing":
            t = g["S"]["t"]
            c[t] = max(0, c[t] - (self.now() - g["turnStart"]))
        return c

    def snapshot(self, g, uid):
        return {
            "id": g["id"], "tc": g["tc"], "label": TCS[g["tc"]]["label"], "base": g["base"], "inc": g["inc"],
            "white": self.pub(g["white"]), "black": self.pub(g["black"]),
            "you": "w" if g["white"]["userId"] == uid else "b" if g["black"]["userId"] == uid else None,
            "moves": list(g["moves"]), "turn": g["S"]["t"], "clocks": self.clocks_now(g),
            "status": g["status"], "result": g.get("result"), "reason": g.get("reason"),
            "drawOffer": g.get("drawOffer"), "ratings": g.get("ratings"),
        }

    def _timer(self, delay_s, fn):
        t = threading.Timer(delay_s, fn)
        t.daemon = True
        t.start()
        return t

    def persist(self, g):
        """A running game is saved after every change, so a restart of the server does not lose it."""
        try:
            self.db.execute("INSERT INTO live_games(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                            (g["id"], json.dumps({"id": g["id"], "tc": g["tc"], "w": g["white"]["userId"], "b": g["black"]["userId"],
                                                  "moves": g["moves"], "clock": g["clock"], "startedAt": g["startedAt"], "drawOffer": g["drawOffer"]})))
        except Exception as e:
            print("could not save live game:", e, flush=True)

    def restore(self):
        """Games that were running when the server stopped come back exactly as they were. Clocks were paused while the
        server was down. Players get the usual grace period to reconnect: one who never returns loses by abandonment,
        and if neither returns the game is aborted (no rating change)."""
        for row in self.db.execute("SELECT id,data FROM live_games").fetchall():
            try:
                d = json.loads(row["data"]); tc = TCS.get(d["tc"])
                if not tc: raise ValueError("unknown time control")
                S, hist, moves = E.start_state(), [], []
                for frm, to, promo in d["moves"]:
                    m = next((x for x in E.legal(S) if x["from"] == frm and x["to"] == to and (x.get("promo") or "") == promo), None)
                    if not m: raise ValueError("saved move is not legal")
                    hist.append(S); S = E.apply(S, m); moves.append([frm, to, promo])
                g = {"id": d["id"], "tc": d["tc"], "base": tc["base"], "inc": tc["inc"], "white": self.player(d["w"]), "black": self.player(d["b"]),
                     "S": S, "hist": hist, "moves": moves, "sans": [], "clock": d["clock"], "turnStart": self.now(), "startedAt": d["startedAt"],
                     "status": "playing", "drawOffer": d.get("drawOffer"), "timer": None}
                self.games[g["id"]] = g; self.user_game[d["w"]] = g["id"]; self.user_game[d["b"]] = g["id"]
                self.schedule_clock(g)

                def grace(g=g):
                    with self.lock:
                        if g["status"] != "playing": return
                        wc, bc = self.has_stream(g["white"]["userId"]), self.has_stream(g["black"]["userId"])
                        if wc and bc: return
                        if not wc and not bc: self.end_game(g, "*", "aborted")
                        else: self.end_game(g, "1-0" if wc else "0-1", "abandonment")
                g["rtimer"] = self._timer(self.abandon_ms / 1000.0, grace)
            except Exception as e:
                print("dropping unreadable live game %s: %s" % (row["id"], e), flush=True)
                self.db.execute("DELETE FROM live_games WHERE id=?", (row["id"],))

    def schedule_clock(self, g):
        if g.get("timer"):
            g["timer"].cancel()
        if not g["base"] or g["status"] != "playing":
            return
        left = g["clock"][g["S"]["t"]] - (self.now() - g["turnStart"])
        g["timer"] = self._timer(max(50, left + 30) / 1000.0, self.tick)

    def tick(self):
        """Ends any game whose side to move has run out of time (also called by timers)."""
        with self.lock:
            for g in list(self.games.values()):
                if g["status"] == "playing" and g["base"] and g["clock"][g["S"]["t"]] - (self.now() - g["turnStart"]) <= 0:
                    self.flag_end(g, g["S"]["t"])

    def flag_end(self, g, loser):
        """`loser` ran out of time. They lose, unless the other side could never checkmate: then it is a draw (FIDE 6.9)."""
        winner = "b" if loser == "w" else "w"
        if not E.can_mate(g["S"], winner): self.end_game(g, "1/2-1/2", "insufficient material")
        else: self.end_game(g, "1-0" if winner == "w" else "0-1", "timeout")

    def start_game(self, a, b, tc_key):
        flip = secrets.randbelow(2) == 1
        wp, bp = self.player(b if flip else a), self.player(a if flip else b)
        tc = TCS[tc_key]
        g = {"id": secrets.token_hex(6), "tc": tc_key, "base": tc["base"], "inc": tc["inc"],
             "white": wp, "black": bp, "S": E.start_state(), "hist": [], "moves": [], "sans": [],
             "clock": {"w": tc["base"], "b": tc["base"]}, "turnStart": self.now(), "startedAt": self.now(),
             "status": "playing", "drawOffer": None, "timer": None}
        self.games[g["id"]] = g
        self.user_game[wp["userId"]] = g["id"]
        self.user_game[bp["userId"]] = g["id"]
        self.last_ended.pop(wp["userId"], None)
        self.last_ended.pop(bp["userId"], None)
        self.persist(g)
        self.schedule_clock(g)
        self.emit(wp["userId"], "matched", {"game": self.snapshot(g, wp["userId"])})
        self.emit(bp["userId"], "matched", {"game": self.snapshot(g, bp["userId"])})
        return g

    @staticmethod
    def expected(ra, rb):
        return 1 / (1 + math.pow(10, (rb - ra) / 400))

    def end_game(self, g, result, reason):
        if g["status"] != "playing":
            return
        g["status"], g["result"], g["reason"] = "ended", result, reason
        for k in ("timer", "rtimer"):
            if g.get(k): g[k].cancel()
        rated = len(g["moves"]) >= 2 and result != "*"
        wb, bb = g["white"]["rating"], g["black"]["rating"]
        wa, ba = wb, bb
        db = self.db
        moves_json = json.dumps(g["moves"], separators=(",", ":"))
        if rated:
            sw = 1 if result == "1-0" else 0 if result == "0-1" else 0.5
            d = js_round(K * (sw - self.expected(wb, bb)))
            wa, ba = max(100, wb + d), max(100, bb - d)
            sql = "UPDATE users SET rating=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE id=?"
            db.execute(sql, (wa, 1 if sw == 1 else 0, 1 if sw == 0 else 0, 1 if sw == 0.5 else 0, g["white"]["userId"]))
            db.execute(sql, (ba, 1 if sw == 0 else 0, 1 if sw == 1 else 0, 1 if sw == 0.5 else 0, g["black"]["userId"]))
            db.execute("INSERT INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (g["id"], g["tc"], g["white"]["userId"], g["black"]["userId"], g["white"]["name"], g["black"]["name"],
                        wb, bb, wa, ba, result, reason, moves_json, g["startedAt"], self.now()))
        g["ratings"] = {"w": {"before": wb, "after": wa}, "b": {"before": bb, "after": ba}}
        g["white"]["rating"], g["black"]["rating"] = wa, ba
        for p in (g["white"], g["black"]):
            self.user_game.pop(p["userId"], None)
            t = self.disc_timers.pop(p["userId"], None)
            if t: t.cancel()
        self.games.pop(g["id"], None)
        try: self.db.execute("DELETE FROM live_games WHERE id=?", (g["id"],))
        except Exception: pass
        self.last_ended[g["white"]["userId"]] = self.snapshot(g, g["white"]["userId"])
        self.last_ended[g["black"]["userId"]] = self.snapshot(g, g["black"]["userId"])
        self.both(g, "end", {"gameId": g["id"], "result": result, "reason": reason, "ratings": g["ratings"], "aborted": not rated})

        def forget():
            with self.lock:
                for p in (g["white"], g["black"]):
                    l = self.last_ended.get(p["userId"])
                    if l and l["id"] == g["id"]:
                        del self.last_ended[p["userId"]]
        self._timer(600, forget)

    def apply_move(self, g, uid, body):
        color = "w" if g["white"]["userId"] == uid else "b" if g["black"]["userId"] == uid else None
        if not color: return 403, "You are not in this game."
        if g["status"] != "playing": return 409, "This game is over."
        if g["S"]["t"] != color: return 409, "Not your turn."
        frm, to, promo = num(body.get("from")), num(body.get("to")), str(body.get("promo") or "").strip().lower()
        ls = E.legal(g["S"])
        m = next((x for x in ls if x["from"] == frm and x["to"] == to and (x.get("promo") or "") == promo), None)
        if not m: return 400, "Illegal move."
        if g["base"]:
            g["clock"][color] -= self.now() - g["turnStart"]
            if g["clock"][color] <= 0:
                g["clock"][color] = 0
                self.flag_end(g, color)
                return 409, "You ran out of time."
            g["clock"][color] += g["inc"]
        ns = E.apply(g["S"], m)
        nl = E.legal(ns)
        chk = E.in_check(ns, ns["t"])
        sn = E.san(g["S"], m, ls) + (("+" if chk else "") if nl else ("#" if chk else ""))
        g["hist"].append(g["S"])
        g["S"], g["turnStart"], g["drawOffer"] = ns, self.now(), None
        g["moves"].append([frm, to, promo])
        g["sans"].append(sn)
        self.persist(g)
        self.both(g, "move", {"gameId": g["id"], "ply": len(g["moves"]), "from": frm, "to": to, "promo": promo,
                              "san": sn, "turn": ns["t"], "clocks": self.clocks_now(g)})
        end = E.end_of(ns, g["hist"])
        if end: self.end_game(g, end["result"], end["reason"])
        else: self.schedule_clock(g)
        return 200, len(g["moves"])

    # ---------- matchmaking ----------
    def find(self, uid, tc):
        cur = self.games.get(self.user_game.get(uid))
        if cur:
            return {"game": self.snapshot(cur, uid)}
        self.user_game.pop(uid, None)
        for i, x in enumerate(self.queue):
            if x["userId"] == uid:
                del self.queue[i]
                break
        i = 0
        while i < len(self.queue):
            w = self.queue[i]
            if w["tc"] != tc or w["userId"] == uid:
                i += 1
                continue
            if not self.has_stream(w["userId"]) or w["userId"] in self.user_game:
                del self.queue[i]
                continue
            del self.queue[i]
            g = self.start_game(w["userId"], uid, tc)
            return {"game": self.snapshot(g, uid)}
        self.queue.append({"userId": uid, "tc": tc})
        return {"queued": True, "tc": tc, "waiting": sum(1 for x in self.queue if x["tc"] == tc)}

    def cancel(self, uid):
        self.queue[:] = [x for x in self.queue if x["userId"] != uid]

    # ---------- streams ----------
    @staticmethod
    def _peer_closed(sock):
        try:
            r, _, _ = select.select([sock], [], [], 0)
            if not r:
                return False
            return sock.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def open_stream(self, h, qs):
        t = (qs.get("ticket") or [""])[0]
        with self.lock:
            e = self.tickets.pop(t, None)                       # single use
            if not e or e["exp"] < self.now():
                return self.fail(h, 401, "Stream ticket expired. Reconnect.")
            uid = e["userId"]
            st = Stream()
            mine = self.streams.setdefault(uid, set())
            mine.add(st)
            while len(mine) > MAX_STREAMS:                      # at most 5 open streams per player: drop the oldest
                old = min(mine, key=lambda x: x.t0)
                mine.discard(old); old.q.put(None)
            tm = self.disc_timers.pop(uid, None)
            if tm: tm.cancel()
            g = self.games.get(self.user_game[uid]) if uid in self.user_game else None
            if g:
                opp = g["black"]["userId"] if g["white"]["userId"] == uid else g["white"]["userId"]
                self.emit(opp, "opponent", {"gameId": g["id"], "state": "connected"})
            self.emit(uid, "hello", {"game": self.snapshot(g, uid) if g else self.last_ended.get(uid)})
        h.close_connection = True
        try:
            h.send_response(200)
            for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache, no-transform"),
                         ("Connection", "close"), ("Access-Control-Allow-Origin", self.cors), ("X-Accel-Buffering", "no")):
                h.send_header(k, v)
            h.end_headers()
            h.wfile.write(b"retry: 3000\n\n")
            h.wfile.flush()
            last = time.monotonic()
            while not self.closing:
                try:
                    msg = st.q.get(timeout=0.25)
                except queue.Empty:
                    if self._peer_closed(h.connection):
                        break
                    if time.monotonic() - last < 20:
                        continue
                    msg = ": ka\n\n"
                if msg is None:
                    break
                h.wfile.write(msg.encode("utf-8"))
                h.wfile.flush()
                last = time.monotonic()
        except OSError:
            pass
        finally:
            self._stream_closed(uid, st)

    def _stream_closed(self, uid, st):
        with self.lock:
            s = self.streams.get(uid)
            if s:
                s.discard(st)
                if not s: del self.streams[uid]
            if self.has_stream(uid) or self.closing:
                return
            self.queue[:] = [x for x in self.queue if x["userId"] != uid]       # stop searching when you leave
            gid = self.user_game.get(uid)
            gm = self.games.get(gid) if gid else None
            if not gm:
                return
            opp = gm["black"]["userId"] if gm["white"]["userId"] == uid else gm["white"]["userId"]
            self.emit(opp, "opponent", {"gameId": gm["id"], "state": "disconnected", "seconds": js_round(self.abandon_ms / 1000)})
            old = self.disc_timers.pop(uid, None)
            if old: old.cancel()

            def abandon():
                with self.lock:
                    if self.has_stream(uid) or gm["status"] != "playing":
                        return
                    if len(gm["moves"]) < 2: self.end_game(gm, "*", "aborted")
                    else: self.end_game(gm, "0-1" if gm["white"]["userId"] == uid else "1-0", "abandonment")
            self.disc_timers[uid] = self._timer(self.abandon_ms / 1000.0, abandon)

    def shutdown(self):
        """Stop all timers and live connections. Running games are already saved and resume when the server starts again."""
        self.closing = True
        for g in list(self.games.values()):
            for k in ("timer", "rtimer"):
                if g.get(k): g[k].cancel()
        for t in list(self.disc_timers.values()): t.cancel()
        self.disc_timers.clear()
        for s in list(self.streams.values()):
            for st in list(s):
                st.q.put(None)

    # ---------- HTTP routes (after sign-in) ----------
    def handle(self, h, p, qs, a):
        """Returns True if the request was one of ours. Runs with the global lock held."""
        m, now = h.command, self.now
        if m == "POST" and p == "/api/stream/ticket":
            t = secrets.token_urlsafe(18)
            self.tickets[t] = {"userId": a["userId"], "exp": now() + 30000}
            for k in [k for k, v in self.tickets.items() if v["exp"] < now()]:
                del self.tickets[k]
            self.send(h, 200, {"ticket": t})
            return True
        if m == "POST" and p == "/api/match/find":
            body = h.json()
            tc = body.get("tc") if isinstance(body.get("tc"), str) and body.get("tc") in TCS else None
            if not tc: self.fail(h, 400, "Unknown time control."); return True
            if not self.has_stream(a["userId"]):
                self.fail(h, 409, "Not connected to the match server yet. Try again in a moment."); return True
            self.send(h, 200, self.find(a["userId"], tc))
            return True
        if m == "POST" and p == "/api/match/cancel":
            self.cancel(a["userId"]); self.send(h, 200, {"ok": True}); return True
        if m == "GET" and p == "/api/game/current":
            uid = a["userId"]
            g = self.games.get(self.user_game[uid]) if uid in self.user_game else None
            self.send(h, 200, {"game": self.snapshot(g, uid) if g else self.last_ended.get(uid)})
            return True
        if m == "GET" and p == "/api/history":
            uid, out = a["userId"], []
            for r in self.db.execute("SELECT * FROM games WHERE white_id=? OR black_id=? ORDER BY ended_at DESC LIMIT 20", (uid, uid)):
                white = r["white_id"] == uid
                win = (white if r["result"] == "1-0" else (not white) if r["result"] == "0-1" else None)
                out.append({"id": r["id"], "tc": r["tc"], "label": (TCS.get(r["tc"]) or {}).get("label", r["tc"]),
                            "you": "w" if white else "b", "opponent": r["black_name"] if white else r["white_name"],
                            "result": r["result"], "reason": r["reason"],
                            "outcome": "draw" if win is None else "win" if win else "loss",
                            "ratingBefore": r["white_before"] if white else r["black_before"],
                            "ratingAfter": r["white_after"] if white else r["black_after"],
                            "moves": json.loads(r["moves"]), "endedAt": r["ended_at"]})
            self.send(h, 200, {"games": out})
            return True
        mm = GAME_ROUTE.match(p)
        if mm and m == "POST":
            g = self.games.get(mm.group(1))
            if not g: self.fail(h, 404, "That game is not running."); return True
            uid = a["userId"]
            color = "w" if g["white"]["userId"] == uid else "b" if g["black"]["userId"] == uid else None
            if not color: self.fail(h, 403, "You are not in this game."); return True
            body, what = h.json(), mm.group(2)
            if what == "move":
                status, r = self.apply_move(g, uid, body)
                if status != 200: self.fail(h, status, r)
                else: self.send(h, 200, {"ok": True, "ply": r})
                return True
            if what == "resign":
                self.end_game(g, "0-1" if color == "w" else "1-0", "resignation"); self.send(h, 200, {"ok": True}); return True
            act = body.get("action")                                     # draw
            opp = g["black"]["userId"] if color == "w" else g["white"]["userId"]
            if act == "offer":
                if g["drawOffer"] == color: self.send(h, 200, {"ok": True}); return True
                if g["drawOffer"] and g["drawOffer"] != color:
                    self.end_game(g, "1/2-1/2", "agreement"); self.send(h, 200, {"ok": True}); return True
                g["drawOffer"] = color; self.persist(g)
                self.emit(opp, "draw", {"gameId": g["id"], "from": color}); self.send(h, 200, {"ok": True}); return True
            if act == "accept" and g["drawOffer"] and g["drawOffer"] != color:
                self.end_game(g, "1/2-1/2", "agreement"); self.send(h, 200, {"ok": True}); return True
            if act == "decline" and g["drawOffer"] and g["drawOffer"] != color:
                g["drawOffer"] = None; self.persist(g)
                self.emit(opp, "drawdeclined", {"gameId": g["id"]}); self.send(h, 200, {"ok": True}); return True
            self.fail(h, 400, "No draw offer to answer."); return True
        return False

    def stats(self):
        return {"queue": len(self.queue), "games": len(self.games)}
