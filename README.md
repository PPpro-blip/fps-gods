# FPS GODS

A browser-based, server-authoritative 3D free-for-all FPS with instant solo bot matches, four weapon bundles, real GLB gun models, and a weapon wheel. Built with vanilla JavaScript, Three.js, Vite, Express, and Socket.IO — zero frameworks on the client.

## Quick start

**Requirements:** Node.js 20.19+ (Node 22+ recommended) and npm.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. `npm run dev` starts the Vite client and the Express/Socket.IO server together; the Vite dev server proxies Socket.IO traffic to port 3001. No environment file is needed for local play.

```bash
npm test        # 31 server/gameplay/weapons tests
npm run build   # production client into dist/client
```

## How to play

The main menu has three buttons:

| Button | What it does |
| --- | --- |
| **PLAY NOW** | Instant solo drop-in against 5 server-side `GOD_BOT_01…05` bots. No room code. |
| **CREATE ROOM** | Private multiplayer room with a six-character invite code (2–16 players). |
| **JOIN ROOM** | Enter a friend's six-character code. |

After entering your callsign and pressing a button you pick a **weapon bundle**, then deploy. First operator to **30 kills** wins. Eliminated players respawn after three seconds with two seconds of spawn protection.

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim |
| Left mouse button | Fire (hold for automatic weapons) |
| `Space` | Jump |
| `R` | Reload |
| `Q` (hold) | Weapon wheel — move mouse to select, release to equip |
| `1` `2` `3` | Direct weapon selection |
| `Tab` | Scoreboard |
| `Esc` | Release pointer lock |

## Weapon bundles

Every bundle carries three weapons. All stats — damage, fire rate, magazine, reload, range, spread — live in `shared/weapons.js` and are enforced **server-side**.

| Bundle | Slot 1 | Slot 2 | Slot 3 |
| --- | --- | --- | --- |
| **RUSHER** | Vortex SMG — fast fire, 30 mag | Harrow Shotgun — close-range 8-pellet blast | Tac Knife — instant kill melee |
| **GHOST** | Wraith Pistol — medium damage, no tracer | Phantom Sniper — one-shot headshot | Smoke Grenade — vision-blocking cloud |
| **HEAVY** | Titan LMG — high fire rate, 60 mag | Ravager Rocket — projectile with splash | Combat Shield — blocks frontal damage |
| **GODS TIER** *(30 lifetime kills)* | God Railgun — hitscan through walls and players | God Minigun — unlimited ammo, overheats after 5 s | God Fist — one punch kill with huge knockback |

- **Weapon wheel (`Q`)** — dark/cyan circular overlay showing all three weapons; mouse direction selects, release equips. The active weapon is highlighted in the wheel and in the bottom-right HUD (icon, name, ammo).
- **Melee & shield** — knife and fist resolve as server-side cone checks; the shield blocks hitscan from the frontal arc (explosions wash around it at half damage).
- **Rocket** — simulated server projectile, direct hits plus radius falloff splash that can hurt anyone, including the shooter.
- **Smoke** — deploys a server-side cloud that blocks bot line-of-sight and any shot through it.
- **GODS TIER unlock** — lifetime kills are stored in the browser and reconciled with server-side totals; the bundle select screen shows your progress.

## Solo bot mode (PLAY NOW)

- Room type `SOLO_VS_BOTS`, private — nobody can join with a code.
- Five bots (`GOD_BOT_01` … `GOD_BOT_05`) think at **10 Hz** on the server: waypoint pathing, rotation toward the nearest human, and fire only with line of sight.
- Bots miss **30 %** of shots (random aim offset), respawn after three seconds, and pick a random bundle.
- Bots are ordinary server players: they fire through the same `SHOOT`/`HIT` pipeline, appear with **[BOT]** tags on the scoreboard and nametags, and show up in the kill feed like anyone else.

## Connection model

- Server Socket.IO CORS is `origin: "*"` — any deployment origin connects.
- Client connects to `import.meta.env.VITE_SOCKET_URL`, falling back to `window.location.origin` when unset.
- HUD connection pill: green dot = connected, red dot = lost with **automatic retry every 3 seconds**.
- Every connection/room error is logged to the browser console.

## Game features

- **Server-owned simulation:** 20 Hz authoritative ticks; the client sends input and renders snapshots. Damage, ammo, reloads, fire cadence, projectiles, smoke, and score never leave the server.
- **Real gun models:** all seven `client/assets/weapons/*.glb` loaded with GLTFLoader — first-person gun + hands in the bottom-right, weapon bob while moving, reload dip animation, muzzle flash + tracers, smooth weapon-switch transitions. Remote players carry the matching world-space model.
- **Arena:** enclosed map, twelve solid cover cubes, eight perimeter spawns; cover blocks shots server-side and visually.
- **Room isolation:** snapshots and gameplay events only reach the Socket.IO room that owns the match.

## Project layout

```text
client/                  Vanilla HTML, CSS, and browser JavaScript
  index.html             Home, bundle select, lobby, match HUD, weapon wheel
  style.css              Responsive game UI (dark/cyan)
  main.js                Three.js renderer and app orchestration
  network.js             Socket.IO client adapter (connection fix, retry)
  player.js              Input, snapshot interpolation, remote capsules + weapons
  world.js               Arena visuals and smoke clouds
  weapons.js             GLB viewmodels, hands, bob/reload/flash/tracers
  ui.js                  DOM menus, bundle select, weapon wheel, HUD
  assets/weapons/*.glb   Real gun models (smg, shotgun, sniper, pistol, lmg, rocket, knife)
server/
  index.js               Express + Socket.IO entrypoint (wildcard CORS)
  rooms.js               Room + solo bot rooms, lifetime kills
  gameState.js           Movement, weapons, damage, projectiles, smoke, scoring
  bots.js                10 Hz server-side bot brains
  hitDetection.js        Ray/cylinder hitboxes, LOS, smoke, wall tests
  origins.js             Wildcard CORS policy
shared/
  events.js              Socket event contract
  gameConfig.js          Map, player, and bot constants
  weapons.js             Weapon + bundle catalog (server-authoritative stats)
test/                    node:test suites (server, gameplay, weapons, origins)
```

## Deployment (Vercel client + persistent Node host)

Vercel serves the static client; Socket.IO needs a persistent process (Railway/Render/Fly — a `render.yaml` blueprint is included).

1. Deploy the Node host (`npm start`). Health checks use `GET /health`.
2. On Vercel set `VITE_SOCKET_URL` to the Node host's public URL and redeploy — or leave it unset to connect to the page's own origin.
3. CORS is wildcard, so no origin allowlist to maintain.

See `.env.example` for every variable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3001` | Game server listen address |
| `GAME_SERVER_URL` | `http://127.0.0.1:3001` | Vite dev proxy target |
| `VITE_PORT` | `5173` | Vite dev server port |
| `VITE_SOCKET_URL` | *(unset → `window.location.origin`)* | Browser-facing game server URL, baked in at build time |
