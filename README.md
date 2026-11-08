# Chess Online

One small Node server + one HTML page. It gives you accounts, daily login streaks, saved games and puzzle progress,
ratings and rankings, online players, and live multiplayer (matchmaking, clocks, draw offers, resign, reconnect).
**No npm install needed.**

## Files

| File | What it does |
|---|---|
| `Chess.html` | The whole game (board, computer opponent, puzzles, review, menu). Served by the server. |
| `server.js` | HTTP API, SQLite database, sessions, streaks, cache. Also serves `Chess.html`. |
| `multiplayer.js` | Matchmaking, live games over Server-Sent Events, clocks, ratings. |
| `engine.js` | Chess rules the server uses to check every online move and decide results. |
| `analyzer.js` | The review / hint engine. It is already built into `Chess.html`; this copy is for reference and editing. |
| `test.js`, `test-multiplayer.js` | Automatic tests (`npm test`). |

If you change the chess rules in `Chess.html`, make the same change in `engine.js`, or online games will disagree with the page.

## Run it on your computer

You need **Node.js 22.13 or newer** (`node --version`).

    node server.js

Open http://localhost:3000. To try multiplayer alone, open it in two different browsers (or one normal and one private window),
create two accounts, and press **Find match** in both.

Check everything works: `npm test`

## Put it online

Multiplayer needs a real server, so static hosts (GitHub Pages, Netlify, plain file upload) will not work.
Use anything that runs Node or Docker:

**Render / Railway / Fly.io (easiest)**
1. Upload this folder to a GitHub repository.
2. Create a new web service from it. It will use the `Dockerfile`. (`render.yaml` is included for Render.)
3. Attach a persistent disk or volume mounted at `/data`, so accounts and games survive restarts.
4. Set `TRUST_PROXY=1` and `DB_PATH=/data/chess.db` (the Dockerfile already sets both).

**Your own server (VPS)**

    node server.js                      # or:  PORT=8080 DB_PATH=/var/lib/chess/chess.db TRUST_PROXY=1 node server.js

Put it behind HTTPS (Caddy or nginx). If you use nginx, turn buffering off for live games:
`proxy_buffering off; proxy_read_timeout 1h;` on the `/api/stream` location.

### Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Most hosts set this for you. |
| `DB_PATH` | `./chess.db` | Where the database file lives. Put it on a persistent disk. |
| `TRUST_PROXY` | off | Set to `1` behind a proxy/host so rate limits use the real visitor address. |
| `CORS_ORIGIN` | `*` | Only needed if the page is hosted on a different address than the server. |
| `HTML_PATH` | `./Chess.html` | Path to the page, if you keep it elsewhere. |

### Back up

Everything is in one file: `chess.db` (plus `chess.db-wal` while running). Copy it while the server is stopped.

## Opening the page as a file

The normal way is to open the address of your server (the page is then served by it and just works).
If you open `Chess.html` straight from your disk instead, the sign-in box shows a **server address** field:
type your server's address there (default `http://localhost:3000`).
