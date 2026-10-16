# FPS GODS

A browser-based, server-authoritative 3D free-for-all FPS. Create a private room, invite up to 15 other operators with a six-character code, and race to 30 eliminations. Built with vanilla JavaScript, Three.js, Vite, Express, and Socket.IO.

## Quick start

**Requirements:** Node.js 20.19+ (Node 22+ recommended) and npm.

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in one or more browser tabs. The development command starts the Vite client and the Express/Socket.IO server together; the Vite dev server proxies Socket.IO traffic to port 3001. No environment file is needed for local play.

To play with friends on the same network, make the Vite URL reachable on your LAN and set `VITE_SOCKET_URL` to the game server's reachable address if the clients cannot use the Vite proxy. See [Configuration](#configuration).

## How to play

1. In the first tab, enter a callsign and choose **Create a room**.
2. Share the displayed six-character room code.
3. Other players open the same site, enter the code, and join. Rooms allow **2–16 real players**; bots are not used.
4. Every player, including the host, presses **Mark ready**. The host starts the match once everyone is ready.
5. Click **Enter arena** and allow pointer lock. Get 30 kills to win.

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim |
| Left mouse button (hold) | Fire the rapid-fire pistol |
| `Space` | Jump |
| `R` | Reload the 12-round magazine |
| `Tab` | Toggle the live scoreboard |
| `Esc` | Release pointer lock; click **Enter arena** to resume |

The pistol deals 25 body damage or 50 headshot damage. Eliminated players respawn after three seconds and are invulnerable for two seconds after respawning. The magazine reloads automatically when empty and can also be reloaded with `R`; reserve ammunition is unlimited.

## Game features

- **Deathmatch FFA:** first player to 30 kills wins; 2–16 connected players per room.
- **Private room lifecycle:** `LOBBY → PLAYING → ENDED → LOBBY`, six-character invite codes, host controls, and a ready-up lobby.
- **Server-owned simulation:** 20 authoritative simulation/state ticks per second. The client sends movement/aim input and renders server snapshots; it does not decide position, damage, hits, health, or score.
- **Server-side combat:** validated fire cadence, reloads, ray/cylinder hitboxes, top-20%-of-capsule headshots, cover occlusion, spawn protection, kill feed, score updates, and victory checks.
- **Arena:** a medium enclosed map with flat ground, boundary walls, twelve solid cover cubes, and eight fixed perimeter spawn points.
- **Presentation:** Three.js first-person camera and pistol, pointer lock, server-snapshot interpolation for remote capsules, nametags, bullet tracers, health/ammo HUD, fading kill feed, and a Tab scoreboard.
- **Room isolation:** game snapshots and gameplay events are emitted only to the Socket.IO room that owns the match.

## Project layout

```text
client/                 Vanilla HTML, CSS, and browser JavaScript
  index.html             Home, lobby, match HUD, and overlays
  style.css              Responsive game UI
  main.js                Three.js renderer and app orchestration
  network.js             Socket.IO client adapter
  player.js              Input, snapshot interpolation, and remote capsules
  world.js               Arena visuals
  weapons.js             First-person pistol and visual-only tracer effects
  ui.js                  DOM-driven lobby, scoreboard, and HUD
server/
  index.js               Express health route, Socket.IO handlers, 20 Hz loop
  origins.js             CLIENT_ORIGIN parsing and wildcard CORS matching
  rooms.js               Room creation, membership, host, and lifecycle
  gameState.js           Authoritative movement, weapons, damage, and scoring
  hitDetection.js        Server-side ray/AABB/cylinder collision
shared/
  events.js              Shared Socket.IO event names and room states
  gameConfig.js          Shared map, spawn, and gameplay constants
test/
  gameplay.test.js       Room, movement, combat, and hit-detection tests
  origins.test.js        CLIENT_ORIGIN wildcard and rejection policy tests
  server.test.js         Health route, CORS headers, and a live Socket.IO handshake
vite.config.js           Vite root and development Socket.IO proxy
vercel.json              Vercel build settings: build at root, publish dist/client
railway.json             Build, start, health check, and restart policy for the server
render.yaml              Alternative blueprint for the persistent Express/Socket.IO server
package.json             Scripts and runtime/development dependencies
package-lock.json        Reproducible npm dependency lockfile
.env.example             Optional local/deployment configuration
.gitignore               Environment, build, and dependency exclusions
```

## Configuration

Copy `.env.example` to `.env` only when you need to change defaults:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address for the Node game server to bind to. |
| `PORT` | `3001` | Express/Socket.IO server port. |
| `GAME_SERVER_URL` | `http://127.0.0.1:3001` | Development Vite proxy target. |
| `VITE_PORT` | `5173` | Vite development port. |
| `VITE_SOCKET_URL` | Same origin | Optional browser-facing Socket.IO server URL, set at client build time for split deployments. |
| `CLIENT_ORIGIN` | Unrestricted | Optional comma-separated browser origins allowed by Socket.IO; entries may use `*` wildcards. Set this in production. |

The Node process exposes a simple health endpoint at `http://localhost:3001/health`.

## Build and deployment

Build the static browser client and run the game server separately:

```bash
npm run build
npm start
```

The static client is written to `dist/client`; the Socket.IO/Express server listens on `PORT`. Production is a **split deployment**: a static host for the client and a persistent Node host for the authoritative server, because serverless/edge functions cannot hold Socket.IO connections open for the length of a match.

### Client on Vercel

`vercel.json` pins the build settings, so the repository builds correctly with no dashboard configuration:

| Setting | Value | Why |
| --- | --- | --- |
| Root Directory | `.` (repository root) | `npm run build` and `vite.config.js` live at the root, not in `client/`. |
| Framework Preset | `vite` | Runs the Vite build. |
| Build Command | `npm run build` | Writes to `dist/client`. |
| Output Directory | `dist/client` | **Vercel's Vite preset assumes `dist`.** Publishing `dist` finds no `index.html` at its root and every route, including `/`, returns `404 NOT_FOUND`. |

`VITE_SOCKET_URL` is inlined at build time, so it must exist as a Vercel environment variable *before* the build runs:

```bash
npm i -g vercel
# Project "fps-gods" in the "pppro-blips-projects" scope (prj_yfbVONCSVJxkQvZj1yIsLLlJFVcm)
vercel link --project fps-gods --scope pppro-blips-projects
vercel env add VITE_SOCKET_URL production   # e.g. https://fps-gods-production-1a2b.up.railway.app
vercel env add VITE_SOCKET_URL preview      # same value
vercel redeploy <deployment-url>            # or push to main: env changes need a rebuild
```

Dashboard equivalent: **Project → Settings → Environment Variables → Add**, name `VITE_SOCKET_URL`, value = game server origin (no trailing slash), environments **Production** and **Preview**, then **Deployments → ⋯ → Redeploy**.

### Game server on a persistent Node host (Railway)

Socket.IO needs long-lived WebSocket connections, and rooms and scores live in memory for the length of a match, so the server must run as a normal Node process — not as a Vercel function. This repository is configured for **Railway** (project `zealous-optimism`, `production` environment) via `railway.json`, which pins `npm ci` → `npm start`, health-checks `/health`, and restarts on failure (max 5 retries). Railway injects `PORT` and `server/index.js` already reads it; `HOST` defaults to `0.0.0.0`.

Two things must be done in the Railway dashboard, because config-as-code cannot express them:

1. **Public domain** — Service → **Settings → Networking → Public Networking → Generate Domain**. Railway gives you `https://<name>-production-<hash>.up.railway.app`. That URL is the value for Vercel's `VITE_SOCKET_URL`.
2. **Allowed client origins** — Service → **Variables**:
   `CLIENT_ORIGIN=https://fps-gods.vercel.app,https://fps-gods-*.vercel.app`

`CLIENT_ORIGIN` entries may contain `*` wildcards, which is how per-deployment Vercel preview URLs are allowed without listing every branch. An empty `CLIENT_ORIGIN` accepts every origin (development default), so multiplayer works before you set it — tighten it before announcing the game publicly. This is a browser policy, not authentication; gameplay stays validated server-side.

Idle services on Railway's lower plans can be put to sleep, so the first player after a quiet period may wait for a cold start. Disable sleeping (or use a higher plan) for an always-warm arena.

`render.yaml` is an equivalent blueprint if you prefer Render (Render → **New → Blueprint** → connect this repository); it produces `https://fps-gods-server.onrender.com` and sets `CLIENT_ORIGIN` for you. Any persistent Node host with WebSocket support works: set `HOST=0.0.0.0`, let the host inject `PORT`, and forward WebSocket upgrades.

### Verify a deployment

```bash
curl -i https://fps-gods.vercel.app/ | head -20          # expect 200 + the FPS GODS HTML, not 404 NOT_FOUND
curl -s https://<railway-domain>/health                  # expect {"status":"ok",...}
curl -i -H "Origin: https://fps-gods.vercel.app" \
  "https://<railway-domain>/socket.io/?EIO=4&transport=polling"  # expect Access-Control-Allow-Origin echoed back
```

Then load the site, confirm the header pill reads `SERVER CONNECTED`, and create a room.

### Single-origin alternative

Serve the static build and proxy `/socket.io` (including WebSocket upgrades) to the Node server from one origin; then leave `VITE_SOCKET_URL` unset so the client uses its own origin. Vite's development proxy is not part of the production build.

## Development notes

- `npm run dev` uses Node's watch mode for the game server and Vite's hot reload for the browser code.
- `npm test` runs the built-in Node test suite for room isolation, input validation, combat, cover raycasts, scoring, respawns, the health route, the `CLIENT_ORIGIN` policy, and a live Socket.IO handshake.
- Shared gameplay constants ensure server collision dimensions and rendered arena geometry stay aligned.
- Rooms and scores are held in memory. Restarting the Node process ends all active rooms; add a persistent store only if cross-restart recovery is needed.
- A match cannot start until every connected player is ready. If a host disconnects, the oldest remaining player becomes host.
- The Socket.IO server accepts origins by default for local development. Restrict `CLIENT_ORIGIN` before exposing a production server publicly; `*` wildcards cover hosts that generate a new URL per deployment.
