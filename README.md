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
  rooms.js               Room creation, membership, host, and lifecycle
  gameState.js           Authoritative movement, weapons, damage, and scoring
  hitDetection.js        Server-side ray/AABB/cylinder collision
shared/
  events.js              Shared Socket.IO event names and room states
  gameConfig.js          Shared map, spawn, and gameplay constants
test/
  gameplay.test.js       Room, movement, combat, and hit-detection tests
vite.config.js           Vite root and development Socket.IO proxy
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
| `CLIENT_ORIGIN` | Unrestricted | Optional comma-separated browser origins allowed by Socket.IO; set this in production. |

The Node process exposes a simple health endpoint at `http://localhost:3001/health`.

## Build and deployment

Build the static browser client and run the game server separately:

```bash
npm run build
npm start
```

The static client is written to `dist/client`; the Socket.IO/Express server listens on `PORT`. For a split deployment:

1. Build the client with `VITE_SOCKET_URL=https://your-game-server.example.com` in the environment used by `npm run build`.
2. Host `dist/client` on any static web host.
3. Deploy the Node server on a persistent Node host with WebSocket support, set `HOST=0.0.0.0`, and configure `CLIENT_ORIGIN` to the exact client origin(s).
4. Ensure the host forwards WebSocket connections and exposes the configured `PORT`.

For a single-origin deployment, serve the static build and proxy `/socket.io` (including WebSocket upgrades) to the Node server. Vite's development proxy is not part of the production build.

## Development notes

- `npm run dev` uses Node's watch mode for the game server and Vite's hot reload for the browser code.
- `npm test` runs the built-in Node test suite for room isolation, input validation, combat, cover raycasts, scoring, and respawns.
- Shared gameplay constants ensure server collision dimensions and rendered arena geometry stay aligned.
- Rooms and scores are held in memory. Restarting the Node process ends all active rooms; add a persistent store only if cross-restart recovery is needed.
- A match cannot start until every connected player is ready. If a host disconnects, the oldest remaining player becomes host.
- The Socket.IO server accepts origins by default for local development. Restrict `CLIENT_ORIGIN` before exposing a production server publicly.
