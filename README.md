# Chess Online (Python)

One small Python server + one HTML page. It gives you accounts, daily login streaks, saved games and puzzle progress,
ratings and rankings, online players, and live multiplayer (matchmaking, clocks, draw offers, resign, reconnect).
SQLite works locally; PostgreSQL is supported for persistent hosted storage through Neon.

## Files

| File | What it does |
|---|---|
| `Chess.html` | The whole game (board, computer opponent, puzzles, review, menu). Served by the server. |
| `server.py` | HTTP API, database-backed sessions and streaks, cache. Also serves `Chess.html`. |
| `database.py` | SQLite/PostgreSQL compatibility layer; selects PostgreSQL when `DATABASE_URL` is set. |
| `multiplayer.py` | Matchmaking, live games over Server-Sent Events, clocks, ratings. |
| `engine.py` | Chess rules the server uses to check every online move and decide results. |
| `test_engine.py`, `test_server.py`, `test_multiplayer.py`, `test_restart.py`, `testutil.py` | Automatic tests. The engine test counts every legal move sequence from six standard positions and compares with the published reference numbers, so any rule mistake shows up. |

The review / hint engine (`analyzer.js`) runs inside the browser and is already built into `Chess.html`, so it is not needed on the server.
If you change the chess rules in `Chess.html`, make the same change in `engine.py`, or online games will disagree with the page.

## Run it on your computer

You need **Python 3.9 or newer** (`python --version`; on some systems the command is `python3`).

    python server.py

Open http://localhost:3000. To try multiplayer alone, open it in two different browsers (or one normal and one private window),
create two accounts, and press **Find match** in both.

Check everything works:

    python test_engine.py
    python test_server.py
    python test_multiplayer.py
    python test_restart.py

## Put it online

Multiplayer needs a real server, so static hosts (GitHub Pages, Netlify, plain file upload) will not work.
Use anything that runs Python or Docker.

**Render Free (Stage 1 — temporary demo)**
1. Upload the files in this folder to a GitHub repository (files at the top level, no subfolder).
2. In Render, create a Blueprint from the repository. It uses `Dockerfile` and `render.yaml`.
3. The included Blueprint uses the Free web-service plan and stores SQLite at `/tmp/chess.db`.
4. Test the website and multiplayer, but do not use this temporary SQLite database for real accounts: Render Free has an ephemeral filesystem and loses local files on restart, spin-down, or redeploy.

**Neon PostgreSQL (Stage 2 — persistent database)**
1. Create a free project at https://neon.com and open its **Connect** modal.
2. Copy the pooled connection string (hostname contains `-pooler`; keep `sslmode=require`).
3. In Render, open the `chess-online` service → **Environment** → add `DATABASE_URL` with that connection string. Do not put it in GitHub or commit it to a file.
4. Save changes and redeploy. The app automatically creates the required PostgreSQL tables and uses Neon instead of SQLite.
5. Check `/api/health`, register a test account, restart/redeploy the service, and log in again to confirm the account persists.

The app keeps SQLite support for local development and automatically selects PostgreSQL whenever `DATABASE_URL` is set. Existing SQLite data is not copied automatically; connect Neon before inviting real players. Neon Free has monthly compute and storage quotas, so monitor usage in its dashboard.

**Your own server (VPS)**

    PORT=8080 DB_PATH=/var/lib/chess/chess.db TRUST_PROXY=1 python server.py

Put it behind HTTPS (Caddy or nginx). With nginx, turn buffering off for live games:
`proxy_buffering off; proxy_read_timeout 1h;` on the `/api/stream` location.

### Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Most hosts set this for you. |
| `DB_PATH` | `./chess.db` | SQLite database path; used only when `DATABASE_URL` is not set. |
| `DATABASE_URL` | unset | PostgreSQL connection string (Neon); takes priority over `DB_PATH`. |
| `TRUST_PROXY` | off | Set to `1` behind a proxy/host so rate limits use the real visitor address. |
| `CORS_ORIGIN` | `*` | Only needed if the page is hosted on a different address than the server. |
| `HTML_PATH` | `./Chess.html` | Path to the page, if you keep it elsewhere. |

### Back up

With SQLite, everything is in `chess.db` (plus `chess.db-wal` while running); copy it while the server is stopped. With Neon, back up the PostgreSQL database using Neon tools or exports.

### Coming from the Node version

The database format is identical. Copy your old `chess.db` next to `server.py` (or point `DB_PATH` at it) and every account,
password, rating and saved game keeps working.

## Opening the page as a file

The normal way is to open the address of your server (the page is then served by it and just works).
If you open `Chess.html` straight from your disk instead, the sign-in box shows a **server address** field:
type your server's address there (default `http://localhost:3000`).

## Good to know

- **Time running out:** the player who runs out of time loses, unless the other side could never checkmate (for example a bare king, or a lone bishop or knight). Then the game is a draw, as in the official rules.
- **Restarting the server** does not lose games in progress. Every running game is saved after each move and comes back as it was, with clocks paused while the server was down. Players get a short grace period to reconnect: a player who never returns loses by abandonment, and if neither returns the game is aborted with no rating change.
- **Limits:** each player can have up to 5 open live connections; request bodies must be JSON objects up to 2 MB.
- **Behind a proxy** (`TRUST_PROXY=1`) the last address in `X-Forwarded-For` is used for rate limits, because earlier ones can be faked by visitors.


### PostgreSQL timestamp compatibility

Millisecond Unix timestamps require PostgreSQL `BIGINT`, not `INTEGER`. The
application now creates timestamp columns as `BIGINT` and widens existing
PostgreSQL timestamp columns during startup. No manual table deletion is needed.
