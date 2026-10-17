# FPS GODS

A browser-based, server-authoritative 3D free-for-all FPS. Play Now drops you into a solo match against five server-driven bots, or create a private room and invite up to 15 other operators with a six-character code. Race to 30 eliminations. Built with vanilla JavaScript, Three.js, Vite, Express, and Socket.IO.

## Quick start

**Requirements:** Node.js 20.19+ (Node 22+ recommended) and npm.

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in one or more browser tabs. The development command starts the Vite client and the Express/Socket.IO server together; the Vite dev server proxies Socket.IO traffic to port 3001. No environment file is needed for local play.

To play with friends on the same network, make the Vite URL reachable on your LAN and set `VITE_SOCKET_URL` to the game server's reachable address if the clients cannot use the Vite proxy. See [Configuration](#configuration).

## How to play

1. Enter a callsign and choose **Play Now** for an instant solo match against five bots.
2. To play with friends, choose **Create Room**, share the six-character room code, and have other players join. Private rooms support **2–16 human players**.
3. Every player, including the host, presses **Mark Ready**. The host starts the match once everyone is ready.
4. Click **Enter Arena** and allow pointer lock. Get 30 kills to win.

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
- **Solo bot mode:** Play Now starts a `SOLO_VS_BOTS` match with GOD_BOT_01–GOD_BOT_05. Their server-side 10 Hz brains patrol random map waypoints, aim at the nearest human, fire only with line of sight, miss 30% of shots with random spread, and respawn after three seconds.
- **Server-side combat:** validated fire cadence, reloads, ray/cylinder hitboxes, top-20%-of-capsule headshots, cover occlusion, spawn protection, kill feed, score updates, and victory checks. Bots use the same authoritative shooting, hit, kill-feed, and scoring path as human players.
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
  origins.js             standalone origin-matching utility (not used by server CORS)
  rooms.js               Room creation, membership, host, and lifecycle
  gameState.js           Authoritative movement, weapons, damage, and scoring
  hitDetection.js        Server-side ray/AABB/cylinder collision
shared/
  events.js              Shared Socket.IO event names and room states
  gameConfig.js          Shared map, spawn, and gameplay constants
test/
  gameplay.test.js       Room, movement, combat, and hit-detection tests
  origins.test.js        origin-matching utility tests
  server.test.js         Health route, CORS headers, and a live Socket.IO handshake
vite.config.js           Vite root and development Socket.IO proxy
vercel.json              Vercel build settings: build at root, publish dist/client
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
| `VITE_SOCKET_URL` | `window.location.origin` | Optional browser-facing Socket.IO server URL, set at client build time for split deployments. |

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

Socket.IO needs long-lived WebSocket connections, and rooms and scores live in memory for the length of a match, so the server must run as a normal Node process — not as a Vercel function. This repository is deployed on **Railway** (project `zealous-optimism`, `production` environment), which auto-detects Node and runs the install plus the `start` script from `package.json` (`node server/index.js`). Railway injects `PORT` and `server/index.js` already reads it; `HOST` defaults to `0.0.0.0`. That auto-detected setup deploys green, so it is intentionally left alone.

Two things to set in the Railway dashboard (they are per-service settings, not repository files):

1. **Public domain** — Service → **Settings → Networking → Public Networking → Generate Domain**. Railway gives you `https://<name>-production-<hash>.up.railway.app`. That URL is the value for Vercel's `VITE_SOCKET_URL`.
2. **Health check** *(recommended)* — Service → **Settings → Deploy → Custom Healthcheck Path**: `/health`. Railway then waits for the server to answer before routing traffic and restarts it if it stops responding.

A `railway.json` pinning these values was tried and **removed**: the deploy it produced failed in ~33s (too fast for the 120s health-check timeout, i.e. the config was rejected early), and Railway logs are not reachable from the environment where this was written. Re-add config-as-code only after confirming the failure reason in the deploy log.

The Socket.IO server returns `Access-Control-Allow-Origin: *`, so no client-origin allowlist is required. CORS is not an authentication mechanism; all gameplay remains validated server-side.

Idle services on Railway's lower plans can be put to sleep, so the first player after a quiet period may wait for a cold start. Disable sleeping (or use a higher plan) for an always-warm arena.

`render.yaml` is an equivalent blueprint if you prefer Render (Render → **New → Blueprint** → connect this repository); it produces `https://fps-gods-server.onrender.com`. Any persistent Node host with WebSocket support works: set `HOST=0.0.0.0`, let the host inject `PORT`, and forward WebSocket upgrades.

### Verify a deployment

```bash
curl -i https://fps-gods.vercel.app/ | head -20          # expect 200 + the FPS GODS HTML, not 404 NOT_FOUND
curl -s https://<railway-domain>/health                  # expect {"status":"ok",...}
curl -i -H "Origin: https://fps-gods.vercel.app" \
  "https://<railway-domain>/socket.io/?EIO=4&transport=polling"  # expect Access-Control-Allow-Origin: *
```

Then load the site, confirm the header pill reads `SERVER CONNECTED`, and create a room.

### Single-origin alternative

Serve the static build and proxy `/socket.io` (including WebSocket upgrades) to the Node server from one origin; then leave `VITE_SOCKET_URL` unset so the client uses its own origin. Vite's development proxy is not part of the production build.

## Development notes

- `npm run dev` uses Node's watch mode for the game server and Vite's hot reload for the browser code.
- `npm test` runs the built-in Node test suite for room isolation, input validation, combat, bot behavior, cover raycasts, scoring, respawns, the health route, wildcard CORS, and live Socket.IO room creation.
- Shared gameplay constants ensure server collision dimensions and rendered arena geometry stay aligned.
- Rooms and scores are held in memory. Restarting the Node process ends all active rooms; add a persistent store only if cross-restart recovery is needed.
- A match cannot start until every connected player is ready. If a host disconnects, the oldest remaining player becomes host.
- Socket.IO CORS is configured for every origin (`*`) in development and production. CORS is not authentication; gameplay rules are validated server-side.
