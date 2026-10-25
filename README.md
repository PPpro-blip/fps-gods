# FPS GODS

A browser-based, server-authoritative 3D free-for-all FPS built with vanilla JavaScript, Three.js, Vite, Express, and Socket.IO. Play instantly against server-driven bots or create/join a live multiplayer room. Choose one of four weapon bundles, use the supplied GLB weapon models, and race to 30 eliminations.

Every operator on screen is the supplied rigged character (`character.glb`, twelve Mixamo clips) wearing procedurally generated tactical gear, holding one of the seven supplied weapon GLBs. The menu backdrop is assembled from the supplied modular environment kit.

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

1. Pick a callsign and a weapon bundle on the first-run screen. GODS TIER unlocks at 30 server-recorded lifetime kills.
2. **PLAY** → `PLAY NOW` drops you into a solo bot match, `CREATE ROOM` opens a private lobby, and the code field joins an existing room. **ROOMS** lists every joinable lobby the server is hosting right now.
3. In a multiplayer lobby, every connected player marks ready; the host starts when all players are ready.
4. Click the arena to capture the mouse and fight. First player to 30 match eliminations wins.

### Screens

| Screen | What it does |
| --- | --- |
| **PLAY** | Deploy solo, create a room, or join with a six-character code |
| **ROOMS** | Live, server-provided lobby browser — refreshes every 5 s, shows host, occupancy, mode and state |
| **INVENTORY** | The four bundles with their real weapon models, roles and asset files; equipping is saved locally and sent with your next join |
| **STORE** | GODS TIER progress, measured from server-verified lifetime eliminations. It is not a checkout: currency and purchases are a later phase, and the screen says so |
| **PROFILE** | Callsign, profile key, lifetime eliminations, unlock progress and the socket this client is dialling |
| **SETTINGS** | Sensitivity, FOV, volume, quality, crosshair style, invert-Y, FPS counter. Stored in this browser only |

Gameplay remains server-authoritative everywhere: the client sends input, trigger pulls, reloads and weapon switches, and draws whatever the server reports back.

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

The local view shows the active gun and procedural hands at the bottom-right of the camera. Moving bobs the weapon; `R` animates reload; accepted shots flash at the muzzle; and weapon switches transition smoothly. Remote operators carry the matching room-synchronized weapon. Tracers use cyan for RUSHER, purple for GHOST, orange for HEAVY, and gold for GODS TIER.

Operators are the real asset: `character.glb` is animated by clips that are chosen by measurement, not by name (all twelve are called `mixamo.com`). Each clip is sampled on a private mixer to derive its ground speed, vertical travel and collapse depth, then assigned to idle / walk / run / jump / death. Horizontal root motion is stripped before playback so a server-positioned operator cannot drift out of its collision capsule, and the local travel speed drives the playback rate so the feet keep up. Helmets, visors, chest plates, packs, shoulder pads, knee pads and boots are built procedurally and parented to the actual bones; the weapon sits in a socket on the right hand.

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
  index.html             Menu shell, screens, lobby, HUD, and overlays
  main.js                Renderer, input, settings/audio wiring, app orchestration
  network.js             Socket.IO client adapter and room-session resume
  player.js              Mouse/keyboard input, snapshot interpolation, remote operators
  animation.js           Clip measurement, state classification, CharacterRig
  operator.js            Procedural tactical gear bound to the character's bones
  MenuStage.js           Three.js menu backdrop built from the environment kit
  AssetManager.js        One-shot GLB loading with progress, cloning and disposal
  world.js               Arena visuals and destructible cover presentation
  weapons.js             GLTFLoader rigs, hands, animations, tracers, and smoke
  settings.js            Local preferences with clamping and persistence
  audio.js               Synthesised weapon/UI cues (Web Audio, no asset files)
  weaponAssets.js        Vite `?url` imports for the seven weapon GLBs
  ui.js                  Screens, room browser, lobby, HUD, scoreboard, wheel
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
  weaponModels.js        Weapon id -> GLB file and measured real-world length
```

## Tests

```bash
npm test
```

108 tests run under `node --test`. Beyond the server room lifecycle and combat rules, the suite covers the things a build cannot:

- `test/ui.test.js` boots the real `client/index.html` in jsdom and drives every screen, button and handler (including a check that no button in the shell is unbound and no duplicate element id exists).
- `test/animation-state.test.js` loads `character.glb` and proves idle / walk / run / jump / death are recognised and that root motion is stripped.
- `test/menu-stage.test.js` builds the menu stage from the real environment kit and character, and checks the operator is dressed on its bones, faces the camera and is inside the frame.
- `test/viewmodel.test.js` checks the first-person weapon sits in front of the near plane for every weapon, that tracers expire and that smoke clouds are disposed.
- `test/client-boot.test.js` and `test/client-match.test.js` boot `client/main.js` in jsdom — the second one against a live server, and asserts the HUD, room code, ammo, health and scoreboard come from real server ticks.

WebGL rendering and pointer-lock behaviour cannot be exercised headlessly; those remain manual checks.

## Assets

Static GLB assets (maps, characters, animations, and weapon models) are provided in `public/assets/` and exposed cleanly to the root build and development server at `/assets/...`.

- **Map** (`/assets/map/arena_map.glb`)
- **Character** (`/assets/characters/character.glb`)
- **Animations** — already embedded in `character.glb`; the separate `public/assets/animations/*.glb` files are byte-identical duplicates or cumulative subsets and are not downloaded at runtime
- **Weapons** (`/assets/weapons/knife.glb`, `lmg.glb`, `pistol.glb`, `rifle.glb`, `rocket.glb`, `shotgun.glb`, `smg.glb`, `sniper.glb`)
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
