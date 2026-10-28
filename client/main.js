import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { DEFAULT_MAP_ID, getMap } from '../shared/maps.js';
import { BUNDLE_BY_ID } from '../shared/bundles.js';
import { GameNetwork } from './network.js';
import { PlayerController, RemotePlayers, StateInterpolator } from './player.js';
import { InputCadence, LocalPrediction } from './prediction.js';
import { InputPump } from './inputPump.js';
import { AimController } from './aim.js';
import { ShotFeedback } from './shotFeedback.js';
import { World } from './world.js';
import { WeaponEffects, WeaponModelLibrary } from './weapons.js';
import { GameUI } from './ui.js';
import { WeaponTrigger } from './trigger.js';
import { MenuStage } from './MenuStage.js';
import { assetManager } from './AssetManager.js';
import { QUALITY_PRESETS, SettingsStore, sensitivityToRadiansPerPixel } from './settings.js';
import { AudioEngine } from './audio.js';

/* ────────────────────────────── local identity ───────────────────────────── */

function getOrCreateProfileId() {
  const stored = localStorage.getItem('fps-gods-profile-id');
  if (stored && /^[A-Za-z0-9_-]{1,96}$/.test(stored)) return stored;
  const profileId = window.crypto?.randomUUID?.()
    ?? `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  localStorage.setItem('fps-gods-profile-id', profileId);
  return profileId;
}

function readRoomSession() {
  try {
    const session = JSON.parse(localStorage.getItem('fps-gods-room-session') ?? 'null');
    if (session && /^[A-Z2-9]{6}$/.test(session.roomCode)
      && typeof session.resumeToken === 'string' && /^[A-Za-z0-9_-]{40,48}$/.test(session.resumeToken)) {
      return session;
    }
  } catch {
    localStorage.removeItem('fps-gods-room-session');
  }
  return null;
}

function clearRoomSession() {
  localStorage.removeItem('fps-gods-room-session');
}

/* ───────────────────────────────── ui + audio ────────────────────────────── */

const profileId = getOrCreateProfileId();
const urlParams = new URLSearchParams(window.location.search);
const roomCodeFromUrl = urlParams.get('room');

const audio = new AudioEngine();
const settings = new SettingsStore({ onChange: (next) => applySettings(next) });
const ui = new GameUI({
  profileId,
  settings: settings.snapshot,
  onChange: (patch) => settings.update(patch),
});

/* ───────────────────────────────── scene setup ───────────────────────────── */

const canvas = document.querySelector('#game-canvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(77, window.innerWidth / window.innerHeight, 0.05, 125);
camera.rotation.order = 'YXZ';
scene.add(camera);

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
} catch (error) {
  console.warn('[FPS GODS] WebGL renderer could not be initialised:', error);
  ui.showWebGLWarning();
}

const world = new World(scene);
const controller = new PlayerController(camera, canvas);
const nameTagRoot = document.querySelector('#name-tags');
const weaponModels = new WeaponModelLibrary();
const interpolator = new StateInterpolator();
const prediction = new LocalPrediction();
const inputCadence = new InputCadence();
const weaponEffects = new WeaponEffects(scene, camera, weaponModels);
const aim = new AimController(camera, weaponEffects);
const remotePlayers = new RemotePlayers(scene, nameTagRoot, weaponModels, assetManager);
const trigger = new WeaponTrigger();
const inputPump = new InputPump(() => {
  if (!canPlay() || !network.connected || !controller.enabled || !latestPlayerAlive) {
    inputPump.stop();
    return;
  }
  const now = performance.now();
  if (trigger.shouldRepeat) fireOnce(now);
  const input = currentInput();
  if (inputCadence.shouldSend(input, now)) {
    network.sendInput(input);
    inputCadence.sent(input, now);
  }
}, { timers: window });

let menuStage = null;
const assetBoot = assetManager.init().catch((error) => {
  console.error('[FPS GODS] Asset boot failed:', error);
  return false;
});
assetManager.onProgress((progress) => ui.setLoadingProgress(progress));

// The menu stage needs the operator rig and the environment kit; the weapon
// library is awaited as well so the stands are populated on the first frame.
Promise.allSettled([assetBoot, weaponModels.ready]).then(() => {
  menuStage = new MenuStage(assetManager, { weaponModels });
  const built = menuStage.build();
  menuStage.resize(window.innerWidth / Math.max(1, window.innerHeight));
  menuStage.show();
  if (menuStage) menuStage.setBundle(ui.selectedBundleId);
  // Lazy models may finish after the menu was built; fill their stands once.
  // Failed weapon loads are visible to players rather than silently presenting
  // empty hands under a weapon label.
  const reportedWeaponFailures = new Set();
  weaponModels.onReady(() => {
    menuStage?.setBundle(ui.selectedBundleId);
    for (const file of weaponModels.errors.keys()) {
      if (reportedWeaponFailures.has(file)) continue;
      reportedWeaponFailures.add(file);
      ui.showToast(`Weapon model unavailable: ${file}. Check the console.`);
    }
  });
  if (!built) console.warn('[FPS GODS] Menu stage running without the operator asset.');
  if (!weaponModels.settled) ui.showToast('Weapon models are still loading…');

  // Required assets are named individually, with the URL the build actually
  // requested, instead of a single vague "operator unavailable" toast. The
  // diagnostic snapshot stays on `window` for bug reports.
  window.__FPS_GODS_ASSETS__ = assetManager.diagnostics();
  if (assetManager.hasFailures) {
    const note = !assetManager.ready && !assetManager.mapReady
      ? 'The build could not load its required 3D assets, so this session is running on fallbacks.'
      : !assetManager.ready
        ? 'The operator model failed to load, so matches are using fallback operators.'
        : 'The environment kit failed to load, so the arena backdrop is simplified.';
    ui.showAssetWarning(assetManager.describeFailures(), { note });
  }
  ui.finishLoading();
});

function describeTarget(target) {
  if (!target) return 'resolving…';
  const source = target.source === 'same-origin'
    ? 'same origin'
    : target.source === 'invalid-override' ? 'invalid VITE_SOCKET_URL' : 'VITE_SOCKET_URL';
  return `${target.url} (${source})`;
}

/* ───────────────────────────── match / input state ───────────────────────── */

let currentRoom = null;
let matchActive = false;
let matchEnded = false;
let weaponWheelOpen = false;
let wheelPointer = { x: 0, y: 0 };
const nextClientShotByWeapon = new Map();
const predictedShots = new ShotFeedback();
let nextShotId = 0;
let rightMouseHeld = false;
let windowFocused = true;
let inputSequence = 0;
let latestPlayers = [];
let latestLocalPlayer = null;
let serverClockOffset = 0;
let latestPlayerAlive = false;
let lastSnapshotTick = -1;
let predictionCover = [];

function canPlay() {
  return matchActive && !matchEnded && currentRoom?.state === 'PLAYING';
}

/**
 * The single place that decides whether the mouse/keyboard are captured.
 *
 * Called on every transition that can change the answer — pointer lock,
 * death, respawn, disconnect, room state, weapon wheel, tab focus — so a
 * respawned operator never ends up with a camera that ignores the mouse, and a
 * dead one never keeps a held key that walks them around.
 */
function syncInputState() {
  const locked = document.pointerLockElement === canvas;
  const playable = canPlay() && !weaponWheelOpen && !ui.scoreboardOpen && latestPlayerAlive && windowFocused && !document.hidden;
  const wasEnabled = controller.enabled;
  controller.setEnabled(locked && playable);
  if (controller.enabled) inputPump.start(); else inputPump.stop();
  if (!locked || !playable) {
    trigger.release();
    releaseRightAction();
  }
  if (wasEnabled && !controller.enabled) sendNeutralInput();
  if (canPlay()) ui.setPaused(!locked && latestPlayerAlive && !matchEnded);
}

function clearMatchPresentation() {
  matchActive = false;
  matchEnded = false;
  trigger.release();
  closeWeaponWheel(false);
  nextClientShotByWeapon.clear();
  predictedShots.clear();
  releaseRightAction();
  aim.reset(true);
  latestPlayers = [];
  latestLocalPlayer = null;
  latestPlayerAlive = false;
  trigger.sync(null, false);
  interpolator.clear();
  prediction.reset();
  inputCadence.reset();
  lastSnapshotTick = -1;
  remotePlayers.clear();
  weaponEffects.updateSmokeClouds([]);
  weaponEffects.clearProjectiles();
  world.resetCover();
  controller.reset();
  controller.setEnabled(false);
  inputPump.stop();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.setScoreboard(false);
  ui.setMatchVisible(false);
  ui.setPaused(false);
  if (menuStage) menuStage.show();
}

/**
 * Build the arena the server picked.
 *
 * The map always comes from the room payload (which the server validated) or
 * from GAME_START — never from a local choice — so two clients in the same room
 * can never render different geometry from the collision they are fighting in.
 */
function syncArena(mapId, { announce = false } = {}) {
  const changed = world.setMap(mapId);
  if (!changed) return false;
  predictionCover = world.map.cover.map((block, id) => ({ ...block, id }));
  if (renderer) {
    renderer.toneMappingExposure = world.map?.lighting?.exposure ?? renderer.toneMappingExposure;
  }
  // Re-derive fog and pixel ratio for the new arena.
  applySettings(settings.snapshot);
  ui.setArena(world.map);
  if (announce) ui.showToast(`Arena: ${world.map.name}`);
  return true;
}

function enterMatch(room = currentRoom) {
  if (!room) return;
  currentRoom = room;
  const wasActive = matchActive && !matchEnded;
  matchActive = true;
  matchEnded = false;
  if (!wasActive) {
    latestPlayers = [];
    latestLocalPlayer = null;
    latestPlayerAlive = false;
    interpolator.clear();
    prediction.reset();
    inputCadence.reset();
    lastSnapshotTick = -1;
    remotePlayers.clear();
    weaponEffects.updateSmokeClouds([]);
    weaponEffects.clearProjectiles();
    nextClientShotByWeapon.clear();
    predictedShots.clear();
    releaseRightAction();
    aim.reset(true);
  }
  // Build the authoritative arena before the first frame of the match.
  syncArena(room.mapId ?? DEFAULT_MAP_ID);
  world.resetCover();
  if (menuStage) menuStage.hide();
  ui.showMatch(room);
  ui.setLobbyVisible(false);
  syncInputState();
}

function closeWeaponWheel(equip = true) {
  if (!weaponWheelOpen) return;
  const selectedWeaponId = ui.closeWeaponWheel();
  weaponWheelOpen = false;
  wheelPointer = { x: 0, y: 0 };
  syncInputState();
  if (equip && selectedWeaponId && latestLocalPlayer
    && selectedWeaponId !== latestLocalPlayer.currentWeaponId && network.connected) {
    network.switchWeapon(selectedWeaponId);
    trigger.release();
  }
}

/* ──────────────────────────────── settings ───────────────────────────────── */

function applySettings(next) {
  controller.setSensitivity(sensitivityToRadiansPerPixel(next.sensitivity));
  controller.setInvertY(next.invertY);
  aim.setHipFov(next.fov);
  audio.setVolume(next.volume);
  const preset = QUALITY_PRESETS[next.quality] ?? QUALITY_PRESETS.high;
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  // Fog starts from the map's own atmosphere and the quality preset scales it,
  // so changing quality never erases a map's identity (or floods it).
  if (scene.fog && world.map) {
    const base = world.map.palette.fog.density;
    scene.fog.density = base * (preset.fog / QUALITY_PRESETS.high.fog);
  }
  if (menuStage?.scene?.fog) menuStage.scene.fog.density = preset.fog * 3.4;
  ui.applySettings(next);
}
applySettings(settings.snapshot);

// Audio may only start inside a user gesture; arm it once and forget.
function unlockAudio() {
  if (audio.unlock()) return;
}
for (const eventName of ['pointerdown', 'keydown']) {
  window.addEventListener(eventName, unlockAudio, { once: true, passive: true });
}

/* ───────────────────────────────── network ───────────────────────────────── */

let autoJoinAttempted = false;

const network = new GameNetwork({
  onConnect: (_socketId, recovered) => {
    ui.setConnectionState('connected');
    ui.setServerTarget(describeTarget(network.connectionTarget));
    network.requestProfile(profileId, ui.playerName);
    if (!recovered) network.resumeRoom(readRoomSession());
    if (roomCodeFromUrl && !autoJoinAttempted) {
      autoJoinAttempted = true;
      ui.showToast(`Joining room ${roomCodeFromUrl.toUpperCase()}…`);
      window.setTimeout(() => {
        network.joinRoom(roomCodeFromUrl, ui.playerName, ui.bundleId, ui.profileId);
      }, 400);
    }
  },
  onDisconnect: (reason) => {
    if (reason === 'io client disconnect') ui.setConnectionState('offline');
    else ui.setConnectionState('offline', 'Connection interrupted. Reconnecting…');
    controller.reset();
    controller.setEnabled(false);
    inputPump.stop();
    prediction.reset();
    inputCadence.reset();
    trigger.release();
    releaseRightAction();
    predictedShots.clear();
    closeWeaponWheel(false);
    if (matchActive) {
      latestPlayerAlive = false;
      ui.setPaused(true);
    }
  },
  onConnectionError: (detail = {}) => ui.setConnectionState(detail.badge ?? 'offline', detail.message),
  onProfileUpdate: (profile) => {
    ui.setProfile(profile);
    if (menuStage) menuStage.setBundle(ui.selectedBundleId);
  },
  onRoomSession: (session) => localStorage.setItem('fps-gods-room-session', JSON.stringify(session)),
  onRoomResumeFailed: (error) => {
    clearRoomSession();
    currentRoom = null;
    if (matchActive) clearMatchPresentation();
    ui.showScreen('play');
    ui.showToast(error?.message ?? 'The previous room session has expired.');
  },
  onRoomLeft: () => {
    clearRoomSession();
    currentRoom = null;
    clearMatchPresentation();
    ui.showScreen('play');
  },
  onRoomList: (payload) => ui.setRoomList(payload),
  onRoomState: (room) => {
    const previousState = currentRoom?.state;
    const previousMap = currentRoom?.mapId;
    currentRoom = room;
    // The host can change the arena while the room is in its lobby; rebuild as
    // soon as the server says so, not when the match starts.
    syncArena(room.mapId ?? DEFAULT_MAP_ID);
    if (previousMap && previousMap !== room.mapId) ui.setArena(world.map);
    ui.room = room;
    ui.selfId = network.id;

    if (room.state === 'PLAYING') {
      enterMatch(room);
    } else if (room.state === 'LOBBY') {
      if (previousState === 'PLAYING' || previousState === 'ENDED' || matchActive) clearMatchPresentation();
      if (menuStage) menuStage.show();
      currentRoom = room;
      ui.showLobby(room, network.id);
    } else if (room.state === 'ENDED') {
      matchEnded = true;
      trigger.release();
      releaseRightAction();
      closeWeaponWheel(false);
      controller.setEnabled(false);
      inputPump.stop();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
  },
  onRoomError: (error) => ui.showError(error?.message),
  onGameStart: (payload = {}) => {
    if (currentRoom && payload.mapId) currentRoom.mapId = payload.mapId;
    enterMatch(currentRoom);
  },
  onGameState: (state) => {
    if (!matchActive || state.code !== currentRoom?.code) return;
    if (Number.isSafeInteger(state.tick)) {
      if (state.tick <= lastSnapshotTick) return;
      lastSnapshotTick = state.tick;
    }
    const receivedAt = performance.now();
    latestPlayers = state.players ?? [];
    interpolator.push(latestPlayers, receivedAt);
    serverClockOffset = (state.serverTime ?? Date.now()) - Date.now();
    latestLocalPlayer = latestPlayers.find((player) => player.id === network.id) ?? null;
    const aliveNow = Boolean(latestLocalPlayer?.alive && latestLocalPlayer?.connected !== false);
    if (Array.isArray(state.cover)) {
      const ids = new Set(state.cover);
      predictionCover = world.map.cover.flatMap((block, id) => ids.has(id) ? [{ ...block, id }] : []);
    }
    if (aliveNow && latestLocalPlayer) {
      if (!latestPlayerAlive) prediction.reset(latestLocalPlayer);
      else prediction.reconcile(latestLocalPlayer, world.map, predictionCover);
    } else if (!aliveNow) prediction.reset();
    if (aliveNow !== latestPlayerAlive) {
      latestPlayerAlive = aliveNow;
      if (!aliveNow) {
        controller.reset();
        trigger.release();
        releaseRightAction();
        closeWeaponWheel(false);
      }
      syncInputState();
    }
    trigger.sync(latestLocalPlayer?.currentWeaponId, latestLocalPlayer?.auto);
    world.updateCover(state.cover);
    weaponEffects.updateSmokeClouds(state.smokeClouds ?? []);
    weaponEffects.updateProjectiles(state.projectiles ?? [], receivedAt);
    if (latestLocalPlayer) {
      syncLocalWeapon(latestLocalPlayer.currentWeaponId, latestLocalPlayer.bundleId);
      weaponEffects.setBlocking(rightMouseHeld && latestLocalPlayer.blocking === true);
      weaponEffects.setMovementSpeed(Math.hypot(latestLocalPlayer.vx ?? 0, latestLocalPlayer.vz ?? 0));
      ui.updateHud(
        latestLocalPlayer,
        Date.now() + serverClockOffset,
        latestPlayers.filter((player) => player.alive && player.connected !== false).length,
      );
    }
    ui.updateScoreboard(latestPlayers, network.id);
  },
  onGameEnd: (result) => {
    matchEnded = true;
    trigger.release();
    releaseRightAction();
    closeWeaponWheel(false);
    controller.reset();
    controller.setEnabled(false);
    inputPump.stop();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    ui.showGameEnd(result, network.id);
  },
  onReturnToLobby: () => {
    clearMatchPresentation();
    if (menuStage) menuStage.show();
    if (currentRoom) ui.showLobby(currentRoom, network.id);
  },
  onPlayerDied: (data) => {
    if (data.victimId !== network.id) return;
    latestPlayerAlive = false;
    prediction.reset();
    if (latestLocalPlayer) {
      latestLocalPlayer.alive = false;
      latestLocalPlayer.health = 0;
      latestLocalPlayer.respawnAt = data.respawnAt;
      ui.updateHud(
        latestLocalPlayer,
        Date.now() + serverClockOffset,
        latestPlayers.filter((player) => player.alive && player.connected !== false).length,
      );
    }
    controller.reset();
    trigger.release();
    releaseRightAction();
    closeWeaponWheel(false);
    syncInputState();
  },
  onPlayerRespawned: (data) => {
    if (data.id !== network.id) return;
    latestPlayerAlive = true;
    if (latestLocalPlayer) Object.assign(latestLocalPlayer, data, { alive: true, grounded: true, vx: 0, vy: 0, vz: 0, knockbackVX: 0, knockbackVZ: 0, wasJumping: false });
    prediction.reset(latestLocalPlayer);
    inputCadence.reset();
    releaseRightAction();
    aim.reset(true);
    nextClientShotByWeapon.clear();
    predictedShots.clear();
    controller.reset();
    // Rebind input immediately: the pointer is still locked, so the operator
    // should be able to aim and move on the first frame after redeploying.
    syncInputState();
    // Never come back mid-reload or mid-swap: reset the viewmodel presentation
    // and re-show the rig in case death hid it.
    weaponEffects.resetPresentation();
    weaponEffects.setVisible(true);
    audio.play('spawn');
    ui.showToast('Redeployed. Two seconds of spawn protection.');
  },
  onKillFeed: (entry) => ui.addKillFeed(entry, network.id),
  onScoreUpdate: (data) => ui.updateScoreboard(data?.players, network.id),
  onHitConfirmed: (hit) => {
    ui.showHitMarker(hit);
    if (hit?.hit) audio.play(hit.killed ? 'kill' : 'hit');
  },
  onAmmoUpdate: (data) => {
    if (!latestLocalPlayer) return;
    Object.assign(latestLocalPlayer, data);
    trigger.sync(latestLocalPlayer.currentWeaponId, latestLocalPlayer.auto);
    syncLocalWeapon(latestLocalPlayer.currentWeaponId, latestLocalPlayer.bundleId);
    if (data.reloading) {
      weaponEffects.startReload((data.reloadCompletesAt ?? Date.now() + 900) - (Date.now() + serverClockOffset));
      audio.play('reload');
    }
    ui.updateHud(
      latestLocalPlayer,
      Date.now() + serverClockOffset,
      latestPlayers.filter((player) => player.alive && player.connected !== false).length,
    );
  },
  onWeaponUpdate: (data) => {
    const player = latestPlayers.find((candidate) => candidate.id === data.playerId);
    if (player) {
      player.bundleId = data.bundleId;
      player.currentWeaponId = data.weaponId;
      player.currentWeaponName = data.weaponName;
      player.currentWeaponIcon = data.weaponIcon;
    }
    if (data.playerId === network.id && latestLocalPlayer) {
      Object.assign(latestLocalPlayer, {
        bundleId: data.bundleId,
        currentWeaponId: data.weaponId,
        currentWeaponName: data.weaponName,
        currentWeaponIcon: data.weaponIcon,
        auto: data.auto === true,
        fireRate: data.fireRate,
      });
      trigger.sync(data.weaponId, data.auto);
      syncLocalWeapon(data.weaponId, data.bundleId);
      ui.updateHud(
        latestLocalPlayer,
        Date.now() + serverClockOffset,
        latestPlayers.filter((candidate) => candidate.alive && candidate.connected !== false).length,
      );
    }
  },
  onWeaponOverheated: (data) => {
    if (data.weaponId === latestLocalPlayer?.currentWeaponId) ui.showToast('MINIGUN OVERHEATED — cooling down.');
  },
  onWeaponFired: (data) => {
    if (data.playerId === network.id) {
      const predicted = predictedShots.consume(data.shotId);
      if (data.weaponId === latestLocalPlayer?.currentWeaponId) {
        weaponEffects.fire(performance.now(), data.weaponId, data.bundleId, data, !predicted);
        if (!predicted) audio.play('shot', { weaponClass: weaponEffects.weaponClass });
      } else {
        weaponEffects.showRemoteTracer(data);
      }
      return;
    }
    remotePlayers.flashWeapon(data.playerId, data.weaponId, data.bundleId);
    weaponEffects.showRemoteTracer(data);
  },
  onSmokeUpdate: (data) => weaponEffects.updateSmokeClouds(data.smokeClouds ?? []),
  onProjectileImpact: (data) => weaponEffects.showImpact(data),
  onCoverDestroyed: (data) => world.destroyCover(data.blockId),
  onHealthUpdate: (data) => {
    if (!latestLocalPlayer) return;
    const previous = latestLocalPlayer.health;
    latestLocalPlayer.health = data.health;
    if (typeof previous === 'number' && data.health < previous) audio.play('damage');
    ui.updateHud(
      latestLocalPlayer,
      Date.now() + serverClockOffset,
      latestPlayers.filter((player) => player.alive && player.connected !== false).length,
    );
  },
});

// The deployment badge is filled in as soon as the socket target is known; it
// must not wait for (or be coupled to) the asset promises above.
ui.setServerTarget(describeTarget(network.connectionTarget));

/* ───────────────────────────────── ui wiring ─────────────────────────────── */

ui.setHandlers({
  onUiSound: () => audio.play('ui'),
  onCallsignContinue: (name, id) => {
    if (network.connected) network.requestProfile(id, name);
  },
  onProfileCallsign: (name) => {
    localStorage.setItem('fps-gods-callsign', name);
    if (network.connected) network.requestProfile(ui.profileId, name);
  },
  onBundleSelected: (bundleId) => {
    if (menuStage) menuStage.setBundle(bundleId);
  },
  onBundleChange: (bundleId) => {
    if (menuStage) menuStage.setBundle(bundleId);
    ui.setServerTarget(describeTarget(network.connectionTarget));
  },
  onPlayNow: (name, bundleId, id, mapId) => {
    if (!network.connected) {
      ui.clearAction();
      ui.showError('Still connecting to the game server. Try again in a moment.');
      return;
    }
    unlockAudio();
    network.playNow(name, bundleId, id, mapId);
  },
  onCreate: (name, bundleId, id, mapId) => {
    if (!network.connected) {
      ui.clearAction();
      ui.showError('Still connecting to the game server. Try again in a moment.');
      return;
    }
    network.createRoom(name, bundleId, id, mapId ?? ui.selectedMapId);
  },
  onSelectMap: (mapId) => {
    // Never trust the local pick as authority: only the host's request to the
    // server changes the room, and every client renders what the server sends.
    ui.selectedMapId = mapId;
    if (network.connected && currentRoom?.state === 'LOBBY') network.setRoomMap(mapId);
  },
  onJoin: (name, code, bundleId, id) => {
    if (!network.connected) {
      ui.clearAction();
      ui.showError('Still connecting to the game server. Try again in a moment.');
      return;
    }
    network.joinRoom(code, name, bundleId, id);
  },
  onListRooms: () => {
    if (!network.connected) {
      ui.setRoomListError('Not connected to the game server yet.');
      return;
    }
    network.listRooms();
  },
  onLeaveRoom: () => network.leaveRoom(),
  onReady: (ready) => network.setReady(ready),
  onStart: () => network.startGame(),
  onReturnToLobby: () => network.returnToLobby(),
  onPlayAgain: () => {
    if (!network.connected) {
      ui.showError('Still reconnecting to the game server. Try again in a moment.');
      return;
    }
    network.playAgain();
  },
  onResume: () => {
    unlockAudio();
    if (canPlay() && document.pointerLockElement !== canvas) {
      const request = canvas.requestPointerLock?.();
      request?.catch?.(() => ui.showToast('Click the arena again to enable pointer lock.'));
    }
  },
});

/* ───────────────────────────────── input ─────────────────────────────────── */

canvas.addEventListener('click', () => {
  unlockAudio();
  if (canPlay() && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) {
    trigger.release();
    closeWeaponWheel(false);
  }
  syncInputState();
});

document.addEventListener('pointerlockerror', () => {
  ui.showToast('Pointer lock was refused. Click the arena to try again.');
  syncInputState();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    trigger.release();
    releaseRightAction();
    closeWeaponWheel(false);
    controller.reset();
    sendNeutralInput();
  }
  syncInputState();
});

document.addEventListener('mousemove', (event) => {
  if (!weaponWheelOpen) return;
  wheelPointer.x += Number(event.movementX) || 0;
  wheelPointer.y += Number(event.movementY) || 0;
  const distance = Math.hypot(wheelPointer.x, wheelPointer.y);
  if (distance > 145) {
    wheelPointer.x = (wheelPointer.x / distance) * 145;
    wheelPointer.y = (wheelPointer.y / distance) * 145;
  }
  ui.selectWeaponByDirection(wheelPointer.x, wheelPointer.y);
});

document.addEventListener('mousedown', (event) => {
  if (!controller.enabled || !network.connected || !latestLocalPlayer) return;
  if (event.button === 2) {
    event.preventDefault();
    if (rightMouseHeld) return;
    rightMouseHeld = true;
    if (latestLocalPlayer.currentWeaponId === 'COMBAT_SHIELD') {
      weaponEffects.setBlocking(true); // cosmetic only; server validates the block
      sendCurrentInput(true);
    } else {
      aim.setHeld(true);
    }
    return;
  }
  if (event.button !== 0) return;
  trigger.press();
  fireOnce(performance.now());
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) trigger.release();
  if (event.button === 2) releaseRightAction();
});

window.addEventListener('blur', () => {
  windowFocused = false;
  trigger.release();
  releaseRightAction();
  closeWeaponWheel(false);
  controller.reset();
  sendNeutralInput();
  syncInputState();
});
window.addEventListener('focus', () => {
  windowFocused = true;
  syncInputState();
});
// UI toggles the scoreboard on the earlier window listener; it owns input
// while open and clears any held keys, trigger or ADS through the same gate.
window.addEventListener('keydown', (event) => {
  if (event.code === 'Tab' && !event.repeat) syncInputState();
});

window.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
  if (controller.isTyping(event.target)) return;

  // A render stall must not delay the server seeing a key edge. Keep the
  // frame heartbeat for held input, but send state transitions immediately.
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)
    && !event.repeat && controller.enabled) {
    sendCurrentInput(true);
    return;
  }

  if (event.code === 'KeyQ' && !event.repeat && controller.enabled) {
    event.preventDefault();
    weaponWheelOpen = true;
    wheelPointer = { x: 0, y: 0 };
    trigger.release();
    releaseRightAction();
    ui.openWeaponWheel(latestLocalPlayer?.bundleId, latestLocalPlayer?.currentWeaponId);
    syncInputState();
    return;
  }

  if (['Digit1', 'Digit2', 'Digit3'].includes(event.code) && !event.repeat && controller.enabled) {
    const index = Number(event.code.slice(-1)) - 1;
    const weaponId = BUNDLE_BY_ID[latestLocalPlayer?.bundleId]?.weapons[index]?.id;
    if (weaponId && weaponId !== latestLocalPlayer?.currentWeaponId && network.connected) {
      event.preventDefault();
      trigger.release();
      releaseRightAction();
      network.switchWeapon(weaponId);
    }
    return;
  }

  if (event.code !== 'KeyR' || event.repeat || !controller.enabled) return;
  event.preventDefault();
  if (!latestLocalPlayer || latestLocalPlayer.reloading || latestLocalPlayer.overheated) return;
  weaponEffects.startReload();
  audio.play('reload');
  network.reload();
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'KeyQ') closeWeaponWheel(true);
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code) && controller.enabled) {
    sendCurrentInput(true);
  }
});

document.addEventListener('wheel', (event) => {
  if (!controller.enabled) return;
  const deltaY = controller.getWheelDelta();
  if (deltaY === 0) return;
  event.preventDefault();
  const bundle = BUNDLE_BY_ID[latestLocalPlayer?.bundleId];
  if (!bundle) return;
  const weapons = bundle.weapons;
  const currentIndex = weapons.findIndex((weapon) => weapon.id === latestLocalPlayer?.currentWeaponId);
  if (currentIndex === -1) return;
  const nextIndex = (currentIndex + (deltaY > 0 ? 1 : -1) + weapons.length) % weapons.length;
  const nextWeaponId = weapons[nextIndex]?.id;
  if (!nextWeaponId || nextWeaponId === latestLocalPlayer?.currentWeaponId || !network.connected) return;
  network.switchWeapon(nextWeaponId);
  releaseRightAction();
  trigger.release();
  trigger.sync(nextWeaponId, false);
}, { passive: false });

function currentInput() {
  const input = controller.getInput(inputSequence++);
  if (!latestPlayerAlive) {
    input.forward = 0;
    input.strafe = 0;
    input.jump = false;
  }
  input.blocking = Boolean(rightMouseHeld && controller.enabled && latestLocalPlayer?.currentWeaponId === 'COMBAT_SHIELD');
  return input;
}

function sendNeutralInput() {
  if (!network.connected || !canPlay()) return;
  const input = currentInput();
  input.forward = 0;
  input.strafe = 0;
  input.jump = false;
  input.blocking = false;
  network.sendInput(input, true);
  inputCadence.sent(input, performance.now());
}

function sendCurrentInput(reliable = false) {
  if (!network.connected || !canPlay()) return;
  const input = currentInput();
  network.sendInput(input, reliable);
  inputCadence.sent(input, performance.now());
}

function releaseRightAction() {
  const wasHeld = rightMouseHeld;
  rightMouseHeld = false;
  aim.reset();
  weaponEffects.setBlocking(false);
  if (wasHeld) sendCurrentInput(true);
}

function syncLocalWeapon(weaponId, bundleId) {
  if (weaponId !== aim.weaponId) {
    releaseRightAction();
    aim.setWeapon(weaponId);
  }
  weaponEffects.setWeapon(weaponId, bundleId);
}

function fireOnce(now) {
  if (!canPlay() || !controller.enabled || !network.connected || !latestPlayerAlive || !latestLocalPlayer
    || latestLocalPlayer.reloading || latestLocalPlayer.overheated
    || latestLocalPlayer.currentWeaponId === 'COMBAT_SHIELD') return;
  const weaponId = latestLocalPlayer.currentWeaponId;
  if (!weaponId || now < (nextClientShotByWeapon.get(weaponId) ?? 0)) return;
  if (!latestLocalPlayer.unlimitedAmmo && latestLocalPlayer.maxAmmo > 0 && latestLocalPlayer.ammo <= 0) {
    audio.play('empty');
    return;
  }
  const rate = Math.max(50, Number(latestLocalPlayer.fireRate) || 100);
  nextClientShotByWeapon.set(weaponId, now + rate);
  // Send the current aim immediately before the action; the server still owns
  // the shot ray and all ammo/cooldown/hit decisions.
  sendCurrentInput(true);
  const shotId = nextShotId++;
  predictedShots.remember(shotId, now);
  network.shoot(shotId);
  weaponEffects.presentFire(now, weaponId, latestLocalPlayer.bundleId);
  audio.play('shot', { weaponClass: weaponEffects.weaponClass });
}

/* ────────────────────────────────── loop ─────────────────────────────────── */

function resize() {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  if (renderer) {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  menuStage?.resize(aspect);
}
window.addEventListener('resize', resize);

let frameCount = 0;
let fpsWindowStart = performance.now();
let lastFrameTime = performance.now();

function animate(now = performance.now()) {
  requestAnimationFrame(animate);
  const frameElapsed = Math.max(0, (now - lastFrameTime) / 1000);
  const delta = Math.min(frameElapsed, 0.1);
  lastFrameTime = now;

  if (!matchActive && menuStage?.built && !menuStage.visible) menuStage.show();

  if (matchActive) {
    if (canPlay() && network.connected) {
      const input = currentInput();
      if (latestPlayerAlive) prediction.step(input, delta, world.map, predictionCover);
    }

    camera.rotation.order = 'YXZ';
    camera.rotation.y = controller.yaw;
    camera.rotation.x = controller.pitch;
    camera.rotation.z = 0;
    const renderAt = now - 90;
    const localPose = prediction.sample(delta) ?? latestLocalPlayer;
    if (localPose) camera.position.set(localPose.x, localPose.y + PLAYER.eyeHeight, localPose.z);
    camera.updateMatrixWorld(true);
    remotePlayers.update(latestPlayers, interpolator, camera, renderAt, network.id);
  }

  weaponEffects.setVisible(matchActive && !matchEnded);
  if (menuStage?.built) {
    if (matchActive) menuStage.hide();
    menuStage.update(delta);
  }
  // ADS is presentation and should catch up after a slow frame; movement
  // simulation remains clamped separately.
  aim.update(frameElapsed);
  weaponEffects.update(now, delta);

  if (renderer) {
    if (matchActive) renderer.render(scene, camera);
    else if (menuStage?.built) renderer.render(menuStage.scene, menuStage.camera);
  }

  frameCount += 1;
  if (now - fpsWindowStart >= 500) {
    ui.setFps((frameCount * 1000) / (now - fpsWindowStart));
    frameCount = 0;
    fpsWindowStart = now;
  }
}
requestAnimationFrame(animate);

// Console breadcrumb for the deployment badge; matches the README's guidance.
console.info(`[FPS GODS] Socket.IO target: ${network.connectionTarget.url} (source: ${network.connectionTarget.source})`);

window.addEventListener('beforeunload', () => {
  // Release GPU resources, sockets and timers on a full page teardown.
  trigger.release();
  controller.dispose();
  weaponEffects.dispose();
  remotePlayers.clear();
  menuStage?.dispose();
  weaponModels.dispose();
  world.dispose();
  assetManager.dispose();
  audio.dispose();
  ui.dispose();
  network.disconnect?.();
});
