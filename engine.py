"""Chess rules used by the server to check every online move and decide results.
Port of engine.js (which was copied from Chess.html). If you change the rules in the page, change them here too.
A position is a dict: b = list of 64 squares ('' or a piece letter), t = 'w'/'b', c = castling rights, ep = en-passant square or -1, hm = half-move clock.
A move is a dict: from, to, and optionally promo / ep / dbl / castle."""

START = [c if c != "." else "" for c in "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR"]
N8 = [(-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)]
K8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
RD = [(-1, 0), (1, 0), (0, -1), (0, 1)]
BD = [(-1, -1), (-1, 1), (1, -1), (1, 1)]
QD = RD + BD


def _m(frm, to, **x):
    d = {"from": frm, "to": to}
    d.update(x)
    return d


def gen(s, col, att=False):
    b, out, W = s["b"], [], col == "w"
    opp = "b" if W else "w"
    for i in range(64):
        p = b[i]
        if not p or (p < "a") != W:
            continue
        t, r, f = p.lower(), i >> 3, i & 7
        if t == "p":
            d = -1 if W else 1
            nr = r + d
            if nr < 0 or nr > 7:
                continue

            def pm(to, i=i, nr=nr):
                if nr == 0 or nr == 7:
                    for pr in "qrbn":
                        out.append(_m(i, to, promo=pr))
                else:
                    out.append(_m(i, to))

            for df in (-1, 1):
                nf = f + df
                if nf < 0 or nf > 7:
                    continue
                to = nr * 8 + nf
                q = b[to]
                if att or (q and (q < "a") != W):
                    pm(to)
                elif to == s["ep"]:
                    out.append(_m(i, to, ep=1))
            if not att:
                to = nr * 8 + f
                if not b[to]:
                    pm(to)
                    if r == (6 if W else 1) and not b[to + d * 8]:
                        out.append(_m(i, to + d * 8, dbl=1))
        elif t == "n" or t == "k":
            for dr, df in (N8 if t == "n" else K8):
                nr, nf = r + dr, f + df
                if nr < 0 or nr > 7 or nf < 0 or nf > 7:
                    continue
                to = nr * 8 + nf
                q = b[to]
                if att or not q or (q < "a") != W:
                    out.append(_m(i, to))
        else:
            for dr, df in (RD if t == "r" else BD if t == "b" else QD):
                nr, nf = r + dr, f + df
                while 0 <= nr < 8 and 0 <= nf < 8:
                    to = nr * 8 + nf
                    q = b[to]
                    if att or not q or (q < "a") != W:
                        out.append(_m(i, to))
                    if q:
                        break
                    nr += dr
                    nf += df
    if not att:
        hr = 56 if W else 0
        ki = hr + 4
        if b[ki] == ("K" if W else "k") and not is_att(s, ki, opp):
            if (("K" if W else "k") in s["c"] and not b[hr + 5] and not b[hr + 6]
                    and b[hr + 7] == ("R" if W else "r") and not is_att(s, hr + 5, opp)):
                out.append(_m(ki, hr + 6, castle=1))
            if (("Q" if W else "q") in s["c"] and not b[hr + 1] and not b[hr + 2] and not b[hr + 3]
                    and b[hr] == ("R" if W else "r") and not is_att(s, hr + 3, opp)):
                out.append(_m(ki, hr + 2, castle=1))
    return out


def is_att(s, sq, by):
    return any(m["to"] == sq for m in gen(s, by, True))


def _find(b, piece):
    try:
        return b.index(piece)
    except ValueError:
        return -1


def in_check(s, col):
    return is_att(s, _find(s["b"], "K" if col == "w" else "k"), "b" if col == "w" else "w")


def apply(s, m):
    b = s["b"][:]
    p = b[m["from"]]
    W = p < "a"
    cap = b[m["to"]]
    b[m["to"]] = p
    b[m["from"]] = ""
    if m.get("ep"):
        b[m["to"] + (8 if W else -8)] = ""
    if m.get("castle"):
        hr = 56 if W else 0
        if m["to"] > m["from"]:
            b[hr + 5] = b[hr + 7]
            b[hr + 7] = ""
        else:
            b[hr + 3] = b[hr]
            b[hr] = ""
    if m.get("promo"):
        b[m["to"]] = m["promo"].upper() if W else m["promo"]
    c = s["c"]
    if p == "K":
        c = c.replace("K", "").replace("Q", "")
    if p == "k":
        c = c.replace("k", "").replace("q", "")
    for q in (m["from"], m["to"]):
        if q == 0: c = c.replace("q", "")
        if q == 7: c = c.replace("k", "")
        if q == 56: c = c.replace("Q", "")
        if q == 63: c = c.replace("K", "")
    return {"b": b, "t": "b" if W else "w", "c": c,
            "ep": (m["from"] + m["to"]) // 2 if m.get("dbl") else -1,
            "hm": 0 if (p.lower() == "p" or cap or m.get("ep")) else s["hm"] + 1}


def legal(s):
    return [m for m in gen(s, s["t"]) if not in_check(apply(s, m), s["t"])]


def san(s, m, ls):
    p = s["b"][m["from"]]
    t = p.lower()
    F = "abcdefgh"
    sq = lambda i: F[i & 7] + str(8 - (i >> 3))
    if m.get("castle"):
        return "O-O" if m["to"] > m["from"] else "O-O-O"
    cap = s["b"][m["to"]] or m.get("ep")
    if t == "p":
        o = (F[m["from"] & 7] + "x") if cap else ""
        o += sq(m["to"])
        if m.get("promo"):
            o += "=" + m["promo"].upper()
        return o
    o = t.upper()
    # other pieces of the same kind that could also reach this square.
    # (compare by squares, not identity: the Node version compared objects and wrote "Ng1f3")
    am = [x for x in ls if not (x["from"] == m["from"] and x["to"] == m["to"] and x.get("promo") == m.get("promo"))
          and s["b"][x["from"]] == p and x["to"] == m["to"]]
    if am:
        if any((x["from"] & 7) == (m["from"] & 7) for x in am):
            o += sq(m["from"]) if any((x["from"] >> 3) == (m["from"] >> 3) for x in am) else str(8 - (m["from"] >> 3))
        else:
            o += F[m["from"] & 7]
    return o + ("x" if cap else "") + sq(m["to"])


def key(s):
    W = s["t"] == "w"
    ep = s["ep"]
    ok = False
    if ep >= 0:
        for d in (-1, 1):
            f = (ep & 7) + d
            if 0 <= f < 8 and s["b"][ep + (8 if W else -8) + d] == ("P" if W else "p"):
                ok = True
    return "".join(p or "." for p in s["b"]) + s["t"] + s["c"] + str(ep if ok else -1)


def castle_of(b):
    return (("K" if b[60] == "K" and b[63] == "R" else "") + ("Q" if b[60] == "K" and b[56] == "R" else "")
            + ("k" if b[4] == "k" and b[7] == "r" else "") + ("q" if b[4] == "k" and b[0] == "r" else ""))


def fen_of(s):
    rows = []
    for y in range(8):
        q, e = "", 0
        for x in range(8):
            p = s["b"][y * 8 + x]
            if p:
                if e: q += str(e); e = 0
                q += p
            else:
                e += 1
        if e: q += str(e)
        rows.append(q)
    ep = "abcdefgh"[s["ep"] & 7] + str(8 - (s["ep"] >> 3)) if s["ep"] >= 0 else "-"
    return "/".join(rows) + " " + s["t"] + " " + (s["c"] or "-") + " " + ep + " " + str(s["hm"]) + " 1"


def parse_fen(f):
    p = f.strip().split()
    if not p: return None
    rows = p[0].split("/")
    b = []
    if len(rows) != 8: return None
    for r in rows:
        n = 0
        for ch in r:
            if ch in "12345678":
                b.extend([""] * int(ch)); n += int(ch)
            elif ch in "pnbrqkPNBRQK":
                b.append(ch); n += 1
            else:
                return None
        if n != 8: return None
    if b.count("K") != 1 or b.count("k") != 1: return None
    if any(x in ("P", "p") for x in b[:8] + b[56:]): return None
    t = "b" if len(p) > 1 and p[1] == "b" else "w"
    have = castle_of(b)
    s = {"b": b, "t": t, "c": "".join(x for x in (p[2] if len(p) > 2 else "") if x in have), "ep": -1,
         "hm": int(p[4]) if len(p) > 4 and p[4].isdigit() else 0}
    e3 = p[3] if len(p) > 3 else ""
    if len(e3) == 2 and e3[0] in "abcdefgh" and e3[1] in "36":
        e = (8 - int(e3[1])) * 8 + "abcdefgh".index(e3[0])
        if (t == "w" and e3[1] == "6" and b[e + 8] == "p" and not b[e]) or (t != "w" and e3[1] == "3" and b[e - 8] == "P" and not b[e]):
            s["ep"] = e
    if in_check(s, "b" if t == "w" else "w"): return None
    return s


def end_of(S, hist):
    """Is the game over? S = current position, hist = the positions before it."""
    ls = legal(S)
    if not ls:
        if in_check(S, S["t"]):
            return {"result": "0-1" if S["t"] == "w" else "1-0", "reason": "checkmate"}
        return {"result": "1/2-1/2", "reason": "stalemate"}
    if S["hm"] >= 100:
        return {"result": "1/2-1/2", "reason": "50-move rule"}
    k = key(S)
    pcs = [p for p in S["b"] if p and p.lower() != "k"]
    if sum(1 for h in hist if key(h) == k) >= 2:
        return {"result": "1/2-1/2", "reason": "repetition"}
    bishops_same = (len(pcs) > 1 and all(p.lower() == "b" for p in pcs)
                    and len({((i >> 3) + (i & 7)) % 2 for i, p in enumerate(S["b"]) if p and p.lower() == "b"}) == 1)
    if len(pcs) == 0 or (len(pcs) == 1 and pcs[0].lower() in "bn") or bishops_same:
        return {"result": "1/2-1/2", "reason": "insufficient material"}
    return None


def can_mate(S, color):
    """Can `color` ever checkmate the other side, even with the other side's help? (FIDE 6.9)
    Used when the OTHER player runs out of time: if `color` can never mate, the game is a draw, not a win on time."""
    own, other = [], []
    for i, p in enumerate(S["b"]):
        if not p or p.lower() == "k":
            continue
        (own if (p < "a") == (color == "w") else other).append((p.lower(), i))
    if any(t in "pqr" for t, _ in own):
        return True
    if not own:
        return False                                          # bare king
    allp = own + other
    if all(t == "b" for t, _ in allp) and len({((i >> 3) + (i & 7)) % 2 for _, i in allp}) == 1:
        return False                                          # only bishops, all on one colour: nobody can ever mate
    if len(own) == 1:
        return len(other) > 0                                 # one minor piece: only with a blocking piece of the opponent's
    return True


def start_state():
    return {"b": START[:], "t": "w", "c": "KQkq", "ep": -1, "hm": 0}
