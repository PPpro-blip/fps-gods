# FPS GODS

A browser-based, server-authoritative 3D free-for-all FPS built with vanilla JavaScript, Three.js, Vite, Express, and Socket.IO. Play instantly against server-driven bots or create/join a live multiplayer room. Choose one of four weapon bundles, use the supplied GLB weapon models, and race to 30 eliminations.

## Quick start

**Requirements:** Node.js 20.19+ (Node 22+ recommended) and npm.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. The development command starts the Vite client and the Express/Socket.IO server together; Vite proxies Socket.IO traffic to port 3000. No environment file is needed for local play.

```bash
npm test        # Node test suite, including live two-client multiplayer coverage
npm run build   # production client into dist/client
```

## How to play

1. Enter a callsign and select a weapon bundle. GODS TIER unlocks at 30 server-recorded lifetime kills.
2. Choose **PLAY NOW** for a solo bot match, **CREATE ROOM** for a private lobby, or **JOIN ROOM** with a six-character code.
3. In a multiplayer lobby, every connected player marks ready; the host starts when all players are ready.
4. Click **Enter Arena** and allow pointer lock. First player to 30 match eliminations wins.

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim |
| Left mouse button | Fire — click for semi-automatic weapons; hold for automatic weapons |
| `Space` | Jump |
| `R` | Reload |
| `Q` (hold) | Weapon wheel — move the mouse to select, release to equip |
| `Tab` | Toggle the scoreboard |
| `Esc` | Release pointer lock; click the arena to resume |

Eliminated operators respawn after three seconds with two seconds of spawn protection.

## Weapon bundles

Each bundle carries three server-validated weapons. Combat stats and damage are resolved by the server, not supplied by the browser.

| Bundle | Slot 1 | Slot 2 | Slot 3 |
| --- | --- | --- | --- |
| **RUSHER** | SMG | Shotgun | Knife |
| **GHOST** | Pistol (no tracer) | Sniper | Smoke Grenade |
| **HEAVY** | LMG | Rocket | Combat Shield |
| **GODS TIER** *(30 lifetime kills)* | Railgun | Minigun | God Fist |

The seven supplied GLBs are loaded with Three.js `GLTFLoader` and shared by first- and third-person weapon rigs:

| Weapon | GLB |
| --- | --- |
| SMG | `smg.glb` |
| Shotgun / Combat Shield | `shotgun.glb` |
| Knife / God Fist | `knife.glb` |
| Pistol / Smoke Grenade | `pistol.glb` |
| Sniper | `sniper.glb` |
| LMG / Railgun / Minigun | `lmg.glb` |
| Rocket | `rocket.glb` |

The local view shows the active gun and procedural hands at the bottom-right of the camera. Moving bobs the weapon; `R` animates reload; accepted shots flash at the muzzle; and weapon switches transition smoothly. Remote operators carry the matching room-synchronized weapon. Tracers use cyan for RUSHER, purple for GHOST, orange for HEAVY, and gold for GODS TIER. Player characters are procedural Three.js primitives with faces and armor details; no character GLBs are used.

## Multiplayer and reconnection

- Multiplayer rooms are isolated Socket.IO rooms with six-character invite codes, a 2–16 player limit, a ready-up lobby, and host controls.
- The server authoritatively simulates movement, hits, health, ammunition, reloads, weapon switches, projectiles, smoke, score, respawns, and victory checks at 20 Hz.
- Weapon changes and accepted shots are broadcast to the room so other clients display the correct model and firing effects.
- A short network interruption freezes the disconnected operator and reserves their seat for 45 seconds. Socket.IO recovery handles brief interruptions; a rotating, server-issued resume token supports a page reload. Rejoining preserves match state, then rotates the token.
- The oldest connected operator becomes host if the current host leaves or disconnects. Disconnected seats expire after the grace period, and the lobby has a leave-room action.
- Lifetime kills are stored server-side in `.data/profiles.json`; the browser keeps only an opaque profile ID. Set `FPS_GODS_PROFILE_PATH` to a durable mounted path on hosts where local files are ephemeral.

## Solo bot mode

**PLAY NOW** starts a private `SOLO_VS_BOTS` match against five bots (`GOD_BOT_01`–`GOD_BOT_05`). Their 10 Hz server-side brains patrol waypoints, aim at the nearest human, fire only with line of sight, miss 30% of shots with randomized aim, select a bundle, and respawn after three seconds. Bots use the same authoritative damage and scoring pipeline as human operators. When a solo match ends, **REDEPLOY** starts a fresh zero-score match against new bots in the same room code; multiplayer hosts use **RETURN TO LOBBY** instead.

## Project layout

```text
client/
  assets/weapons/        Seven supplied GLB weapon assets
  index.html             Callsign, bundles, room menu, HUD, and overlays
  main.js                Three.js renderer, controls, and app orchestration
  network.js             Socket.IO client adapter and room-session resume
  player.js              Input, interpolation, procedural operators, remote guns
  world.js               Arena visuals and destructible cover presentation
  weapons.js             GLTFLoader rigs, hands, animations, tracers, and smoke
  ui.js                  Bundle selection, lobby, scoreboard, and HUD
server/
  index.js               Express/Socket.IO server and 20 Hz simulation loop
  rooms.js               Room lifecycle, recovery tokens, and host migration
  gameState.js           Movement, bots, weapons, damage, and scoring
  hitDetection.js        Server raycasts and damage-zone checks
  profiles.js            Persistent lifetime-kill profiles and bundle unlocks
  weaponConfig.js        Authoritative weapon definitions and loadouts
shared/
  bundles.js             Client-safe bundle presentation and weapon mapping data
  events.js              Shared Socket.IO event contract
  gameConfig.js          Map and player constants
```

## Assets

Every GLB is referenced through a Vite `?url` import (`client/weapons.js`, `client/AssetManager.js`), which emits it into `dist/client/assets/` under a content hash. There is **no `public/` directory and there must not be a hand-written `/assets/foo.glb` string** in client code: with `root: 'client'` Vite's `publicDir` resolves to `client/public`, so a literal web path is copied nowhere and 404s in production while the loader's `catch` turns it into a silent `null`. That is what the original "asset 404s" report actually was — `arena_map.glb`, `animations.glb` and `rifle.glb` name files that have never existed in this repository. `test/assets.test.js` enforces the import rule, so a bad path fails `npm test` instead of shipping.

Two asset loads were deliberately **not** re-pointed at the real files, because the assets themselves don't support them:

- **Map** (`client/assets/map/map-assets.glb`, 3.0 MB) — `getMap()` has no callers; `world.js` builds the arena procedurally. Loading it would ship 3 MB nobody reads.
- **Animations** (`client/assets/animations/Animation_1..5.glb`, 13 MB total) — the loader expects one GLB whose clips are named per `ANIMATION_MAP` (`Idle`, `Run`, …) and whose rig matches `character.glb`. In the actual files every clip is named `mixamo.com`/`mixamo.com.00N`, and each file carries its own `mixamorig:*` skeleton while `character.glb` ships a different rig with zero animations. So those clips cannot drive the lobby character at all. Restoring animation needs an art decision — re-export one retargeted GLB with named clips, or render the rig embedded in one of the five files — not a path change. The lobby currently shows the character in its bind pose.

## Deployment

The client is a static Vite build; Socket.IO needs a persistent Node.js process. A Render blueprint is included in `render.yaml`.

1. Deploy the server with `npm start`; `GET /health` is available for host checks.
2. Set `VITE_SOCKET_URL` to the public game-server URL before building the static client when the client and server use different origins. If it is unset, the browser uses `window.location.origin` (suitable for same-origin proxy deployments).
3. Configure `FPS_GODS_PROFILE_PATH` on persistent storage if lifetime progression must survive server redeploys.

Socket.IO accepts cross-origin connections. CORS is not authentication; gameplay and profile progression are validated server-side.

### Ports

`shared/deployment.js` holds `DEFAULT_GAME_SERVER_PORT` (3000), and both the server's
`PORT` fallback and Vite's dev proxy target derive from it, so the two can never
drive apart. Treat that number as a **local** default only. Railway and Render
inject `PORT` at runtime and the app binds the injected value, so the fallback is
never what decides a production port — Railway injects `8080` by default, not
`3000`. If a Railway service starts but the public domain returns 502, the cause
is the domain's **target port** not matching the port the app actually listens
on: check `Service → Settings → Networking → Public Networking`, and either clear
the explicit target port so Railway uses its own injected `PORT`, or pin `PORT` as
a service variable to the same value as the target port. Do not "fix" this by
editing the fallback in `shared/deployment.js`, and do not hardcode a port.

### Reading the connection badge

`GET /health` answers `{ status, service, uptime, rooms, connections, now }`. The client calls it whenever the handshake fails, because the Socket.IO error object cannot distinguish the causes — over the websocket transport a refused connection, a DNS failure, and a 404 from a host that is not the game server all surface as the same `Error("websocket error")`.

| Badge | Meaning | Fix |
| --- | --- | --- |
| **LIVE ARENA** | Handshake complete. | — |
| **CONNECTING TO SERVER** | First attempt in flight, or a host that is still booting. | Wait; retries continue automatically with backoff. |
| **SERVER OFFLINE** | Nothing answered at the configured address, so the process is down, asleep, or cold-starting. Check the host, then just wait. | Railway/Render: confirm the deploy is `success` and not scaled to zero. |
| **CONNECTION LOST** | Something answered, but it is not the arena server — the client is pointed at the wrong host (typically `VITE_SOCKET_URL` missing at build time, so it fell back to the static client origin), or a proxy is not forwarding `/socket.io` upgrades. Waiting will not help. | `vercel env add VITE_SOCKET_URL production` then redeploy, and confirm the value is in the build log. |

To check the server from anywhere: `curl -s https://<game-server-host>/health`. To confirm what the deployed bundle is dialling, load the site and read the `[FPS GODS] Socket.IO target: … (source: …)` console line.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Game-server listen address |
| `PORT` | `3000` | Local game-server port; **overridden by the host's injected `PORT`** |
| `GAME_SERVER_URL` | `http://127.0.0.1:3000` | Vite development proxy target |
| `VITE_PORT` | `5173` | Vite development server port |
| `VITE_SOCKET_URL` | Unset | Browser-facing Socket.IO server URL, baked into the client build |
| `FPS_GODS_PROFILE_PATH` | `.data/profiles.json` | Persistent server profile store path |
