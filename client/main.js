import { restoreAuthSession } from './authSession.js';
import { CombatIntel } from './combatIntel.js';
import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { DEFAULT_MAP_ID } from '../shared/maps.js';
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
import { RuntimeDiagnostics } from './diagnostics.js';

/* ────────────────────────────── local identity ───────────────────────────── */

function getOrCreateProfileId() {
  const stored = localStorage.getItem('fps-gods-profile-id');
  if (stored && !stored.startsWith('acct_') && /^[A-Za-z0-9_-]{1,96}$/.test(stored)) return stored;
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

const guestProfileId = getOrCreateProfileId();
const diagnostics = new RuntimeDiagnostics();
window.__FPS_GODS_DIAGNOSTICS__ = diagnostics;

const urlParams = new URLSearchParams(window.location.search);
const roomCodeFromUrl = urlParams.get('room');

const audio = new AudioEngine();
const settings = new SettingsStore({ onChange: (next) => applySettings(next) });
const ui = new GameUI({
  profileId: guestProfileId,
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
const aim = new AimController(camera, weaponEffects, {
  onStateChange: (state) => {
    controller.setLookScale(state.lookScale ?? 1);
    ui.setAimPresentation(state);
  },
});
const remotePlayers = new RemotePlayers(scene, nameTagRoot, weaponModels, assetManager);
const combatIntel = new CombatIntel(nameTagRoot);
const trigger = new WeaponTrigger();
const inputPump = new InputPump(() => {
  if (!canPlay() || !network.connected || !controller.enabled || !latestPlayerAlive) {
    inputPump.stop();
    return;
  }
  const now = performance.now();
  if (trigger.shouldRepeat) fireOnce(now);
  const probe = sampleLocalInput();
  if (inputCadence.shouldSend(probe, now, prediction.hasActiveMotion())) {
    sendCurrentInput(false, now);
  }
}, { timers: window });

let menuStage = null;
const assetBoot = assetManager.init().catch((error) => {
  console.error('[FPS GODS] Asset boot failed:', error);
  return false;
});
assetManager.onProgress((progress) => ui.setLoadingProgress(progress));

Promise.allSettled([assetBoot, weaponModels.ready]).then(() => {
  menuStage = new MenuStage(assetManager, { weaponModels });
  const built = menuStage.build();
  menuStage.resize(window.innerWidth / Math.max(1, window.innerHeight));
  menuStage.show();
  if (menuStage) menuStage.setBundle(ui.selectedBundleId);
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
let intelSmoke = [];
let nextPingId = 1;
let pingInterval = null;
let cameraStridePhase = 0;
let cameraBobX = 0;
let cameraBobY = 0;
let cameraLandingDip = 0;
let cameraStrafeRoll = 0;
let wasLocalGrounded = true;
let lastAirborneVy = 0;

weaponEffects.setArenaContext({
  getMap: () => world.map,
  getCover: () => predictionCover,
});

function resetCameraMotionState() {
  cameraStridePhase = 0;
  cameraBobX = 0;
  cameraBobY = 0;
  cameraLandingDip = 0;
  cameraStrafeRoll = 0;
  wasLocalGrounded = true;
  lastAirborneVy = 0;
}

function canPlay() {
  return matchActive && !matchEnded && currentRoom?.state === 'PLAYING';
}

function startPingLoop() {
  stopPingLoop();
  const firePing = () => {
    if (!network.connected) return;
    const payload = diagnostics.createPing(performance.now());
    network.sendPing(payload);
  };
  firePing();
  pingInterval = setInterval(firePing, 2_000);
  pingInterval.unref?.();
}

function stopPingLoop() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

/**
 * The single place that decides whether the mouse/keyboard are captured.
 */
function syncInputState() {
  const locked = document.pointerLockElement === canvas;
  const playable = canPlay() && !weaponWheelOpen && !ui.scoreboardOpen && latestPlayerAlive && windowFocused && !document.hidden;
  const wasEnabled = controller.enabled;
  controller.setEnabled(locked && playable, {
    preserveKeys: canPlay() && !weaponWheelOpen,
  });
  if (controller.enabled) {
    inputPump.start();
    // Flush held movement immediately on capture/respawn so keys pressed prior
    // to pointer lock or respawn never suffer a startup delay.
    if (!wasEnabled) sendCurrentInput(true);
  } else {
    inputPump.stop();
  }
  if (!locked || !playable) {
    trigger.release();
    releaseRightAction();
  }
  if (wasEnabled && !controller.enabled) sendNeutralInput();
  if (canPlay()) ui.setPaused(!locked && (latestPlayerAlive || latestLocalPlayer === null) && !matchEnded);
}

function clearMatchPresentation() {
  matchActive = false;
  matchEnded = false;
  audio.setAmbience(null);
  resetCameraMotionState();
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
  combatIntel.clear();
  intelSmoke = [];
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

function syncArena(mapId, { announce = false } = {}) {
  const changed = world.setMap(mapId);
  if (!changed) return false;
  predictionCover = world.map.cover.map((block, id) => ({ ...block, id }));
  if (renderer) {
    renderer.toneMappingExposure = world.map?.lighting?.exposure ?? renderer.toneMappingExposure;
  }
  applySettings(settings.snapshot);
  ui.setArena(world.map);
  if (matchActive && !matchEnded) {
    audio.setAmbience(world.map?.scenery?.style ?? 'foundry');
  }
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
    resetCameraMotionState();
    latestPlayers = [];
    latestLocalPlayer = null;
    latestPlayerAlive = false;
    interpolator.clear();
    prediction.reset();
    inputCadence.reset();
    lastSnapshotTick = -1;
    remotePlayers.clear();
    combatIntel.clear();
    intelSmoke = [];
    weaponEffects.updateSmokeClouds([]);
    weaponEffects.clearProjectiles();
    nextClientShotByWeapon.clear();
    predictedShots.clear();
    releaseRightAction();
    aim.reset(true);
  }
  const mapChanged = syncArena(room.mapId ?? DEFAULT_MAP_ID);
  if (!wasActive || mapChanged) world.resetCover();
  audio.setAmbience(world.map?.scenery?.style ?? 'foundry');
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
  if (scene.fog && world.map) {
    const base = world.map.palette.fog.density;
    scene.fog.density = base * (preset.fog / QUALITY_PRESETS.high.fog);
  }
  if (menuStage?.scene?.fog) menuStage.scene.fog.density = preset.fog * 3.4;
  ui.applySettings(next);
}
applySettings(settings.snapshot);

function unlockAudio() {
  if (audio.unlock()) return;
}
for (const eventName of ['pointerdown', 'keydown']) {
  window.addEventListener(eventName, unlockAudio, { once: true, passive: true });
}

/* ───────────────────────────────── network ───────────────────────────────── */

let autoJoinAttempted = false;

try { window.sessionStorage?.removeItem('fps-gods-auth-token'); } catch {}

const network = new GameNetwork(
  {
    onConnect: (_socketId, recovered) => {
      ui.setConnectionState('connected');
      ui.setServerTarget(describeTarget(network.connectionTarget));
      startPingLoop();
      bootstrapAuthSession();
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
      combatIntel.clear();
      stopPingLoop();
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
    onPong: (payload = {}) => {
      const rtt = diagnostics.recordPong(payload, performance.now());
      if (rtt !== null) ui.setPing(rtt);
    },
    onProfileUpdate: (profile) => {
      if (!profile?.authenticated && (ui.authState.restoring || ui.profile.authenticated)) return;
      ui.setProfile(profile);
      if (menuStage) menuStage.setBundle(ui.selectedBundleId);
    },
    onWalletUpdate: (wallet) => {
      if (!wallet?.accountId && ui.profile.authenticated) { bootstrapAuthSession(); return; }
      if (!wallet?.accountId && ui.authState.restoring) return;
      ui.setWallet(wallet, { loading: false, error: '' });
    },
    onRewardEarned: (reward) => {
      ui.showRewardEarned(reward);
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
    onRoomError: (error) => {
      if (!matchActive && document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
      ui.showError(error?.message);
    },
    onGameStart: (payload = {}) => {
      if (currentRoom && payload.mapId) currentRoom.mapId = payload.mapId;
      if (currentRoom && payload.botDifficulty) currentRoom.botDifficulty = payload.botDifficulty;
      enterMatch(currentRoom);
    },
    onGameState: (state) => {
      if (!matchActive || state.code !== currentRoom?.code) return;
      if (Number.isSafeInteger(state.tick)) {
        if (state.tick <= lastSnapshotTick) return;
        lastSnapshotTick = state.tick;
      }
      if (state.botDifficulty && currentRoom && currentRoom.botDifficulty !== state.botDifficulty) {
        currentRoom.botDifficulty = state.botDifficulty;
        ui.syncBotDifficultyUI(state.botDifficulty);
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
        let driftMeters = 0;
        if (!latestPlayerAlive) prediction.reset(latestLocalPlayer);
        else driftMeters = prediction.reconcile(latestLocalPlayer, world.map, predictionCover);
        diagnostics.recordSnapshot(latestLocalPlayer.inputAck, driftMeters, receivedAt);
      } else if (!aliveNow) {
        prediction.reset();
      }
      if (aliveNow !== latestPlayerAlive) {
        latestPlayerAlive = aliveNow;
        if (!aliveNow) {
          controller.resetTransientState();
          trigger.release();
          releaseRightAction();
          closeWeaponWheel(false);
        }
        syncInputState();
      }
      trigger.sync(latestLocalPlayer?.currentWeaponId, latestLocalPlayer?.auto);
      world.updateCover(state.cover);
      intelSmoke = state.smokeClouds ?? [];
      weaponEffects.updateSmokeClouds(intelSmoke);
      weaponEffects.updateProjectiles(state.projectiles ?? [], receivedAt);
      if (latestLocalPlayer) {
        syncLocalWeapon(latestLocalPlayer.currentWeaponId, latestLocalPlayer.bundleId);
        weaponEffects.setBlocking(rightMouseHeld && latestLocalPlayer.blocking === true);
        const motionRef = prediction.state ?? latestLocalPlayer;
        weaponEffects.setMovementSpeed(Math.hypot(motionRef.vx ?? 0, motionRef.vz ?? 0));
        ui.updateHud(
          latestLocalPlayer,
          Date.now() + serverClockOffset,
          latestPlayers.filter((player) => player.alive && player.connected !== false).length,
        );
      }
      ui.updateScoreboard(latestPlayers, network.id);
    },
    onGameEnd: (result) => {
      combatIntel.clear();
      matchEnded = true;
      audio.setAmbience(null);
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
      combatIntel.resetTarget(data.victimId);
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
      controller.resetTransientState();
      trigger.release();
      releaseRightAction();
      closeWeaponWheel(false);
      syncInputState();
    },
    onPlayerRespawned: (data) => {
      combatIntel.resetTarget(data.id);
      if (data.id !== network.id) return;
      latestPlayerAlive = true;
      if (latestLocalPlayer) {
        Object.assign(latestLocalPlayer, data, {
          health: PLAYER.maxHealth, alive: true, grounded: true, vx: 0, vy: 0, vz: 0, knockbackVX: 0, knockbackVZ: 0, wasJumping: false,
        });
      }
      prediction.reset(latestLocalPlayer);
      resetCameraMotionState();
      inputCadence.reset();
      releaseRightAction();
      aim.reset(true);
      nextClientShotByWeapon.clear();
      predictedShots.clear();
      controller.resetTransientState();
      syncInputState();
      weaponEffects.resetPresentation();
      weaponEffects.setVisible(true);
      audio.play('spawn');
      ui.showToast('Redeployed. Two seconds of spawn protection.');
    },
    onKillFeed: (entry) => {
      ui.addKillFeed(entry, network.id);
      if (entry?.killerId === network.id) {
        ui.showEliminationBanner(entry);
      }
    },
    onScoreUpdate: (data) => ui.updateScoreboard(data?.players, network.id),
    onOpponentHealth: (data) => combatIntel.health(data),
    onHitConfirmed: (hit) => {
      combatIntel.hit(hit);
      ui.showHitMarker(hit);
      if (hit?.hit) {
        if (hit.targetId) remotePlayers.triggerHitReaction(hit.targetId, hit.headshot);
        audio.play(hit.killed ? 'kill' : 'hit', {
          headshot: Boolean(hit.headshot),
          blocked: Boolean(hit.protected || hit.blockedByShield),
        });
      }
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
        const previousWeaponId = latestLocalPlayer.currentWeaponId;
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
        if (matchActive && previousWeaponId && previousWeaponId !== data.weaponId) {
          audio.play('switch');
        }
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
        const now = performance.now();
        diagnostics.recordShotConfirmed(now);
        const predicted = predictedShots.consume(data.shotId);
        if (data.weaponId === latestLocalPlayer?.currentWeaponId) {
          weaponEffects.fire(now, data.weaponId, data.bundleId, data, !predicted);
          if (!predicted) audio.play('shot', { weaponId: data.weaponId, weaponClass: weaponEffects.weaponClass });
        } else {
          weaponEffects.showRemoteTracer(data);
        }
        return;
      }
      remotePlayers.flashWeapon(data.playerId, data.weaponId, data.bundleId);
      weaponEffects.showRemoteTracer(data);
    },
    onSmokeUpdate: (data) => { intelSmoke = data.smokeClouds ?? []; weaponEffects.updateSmokeClouds(intelSmoke); },
    onProjectileImpact: (data) => {
      weaponEffects.showImpact(data);
      audio.play('explosion');
    },
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
  },
);

ui.setServerTarget(describeTarget(network.connectionTarget));

/* ─────────────────────────── email otp + wallet api ──────────────────────── */

let authBootInFlight = false;

async function bootstrapAuthSession() {
  if (authBootInFlight) return;
  authBootInFlight = true;
  try {
    await restoreAuthSession(ui, network, guestProfileId);
  } finally {
    authBootInFlight = false;
  }
}

async function refreshWallet() {
  if (!ui.profile.authenticated) return;
  ui.setWallet(null, { loading: true, error: '' });
  try {
    const res = await network.apiRequest('/api/wallet');
    ui.setWallet(res.wallet, { loading: false, error: '' });
  } catch (error) {
    ui.setWallet(null, { loading: false, error: error?.message || 'Could not load wallet.' });
  }
}

bootstrapAuthSession();

/* ───────────────────────────────── ui wiring ─────────────────────────────── */

ui.setHandlers({
  onUiSound: () => audio.play('ui'),
  onCallsignContinue: (name, id) => {
    if (network.connected) network.requestProfile(id, name);
  },
  onProfileCallsign: async (name) => {
    if (ui.profile.authenticated) {
      const res = await network.apiRequest('/api/auth/profile', { method: 'POST', body: { callsign: name } });
      if (res?.account) ui.setProfile(res.account);
      if (res?.wallet) ui.setWallet(res.wallet, { loading: false, error: '' });
    } else {
      localStorage.setItem('fps-gods-callsign', name);
      if (network.connected) network.requestProfile(ui.profileId, name);
    }
  },
  onBundleChange: (bundleId) => {
    if (menuStage) menuStage.setBundle(bundleId);
    ui.setServerTarget(describeTarget(network.connectionTarget));
    if (ui.profile.authenticated) {
      network.apiRequest('/api/auth/profile', {
        method: 'POST',
        body: { selectedBundle: bundleId },
      }).catch(() => {});
    }
  },
  onRequestOtp: async (email) => {
    await network.apiRequest('/api/auth/otp/request', {
      method: 'POST',
      body: { email },
    });
  },
  onVerifyOtp: async ({ email, code, callsign, selectedBundle }) => {
    await network.apiRequest('/api/auth/otp/verify', {
      method: 'POST',
      body: { email, code, callsign, selectedBundle },
    });
    const restored = await network.apiRequest('/api/auth/me');
    if (!restored?.authenticated || !restored.account) {
      throw new Error('Sign-in could not be persisted. Allow third-party cookies for this site and try again.');
    }
    // Reconnect so the Socket.IO handshake carries the new HttpOnly cookie.
    if (network.connected) {
      network.socket.disconnect().connect();
    }
    ui.setProfile(restored.account);
    ui.setWallet(restored.wallet, { loading: false, error: '' });
  },
  onLogout: async () => {
    await network.apiRequest('/api/auth/logout', { method: 'POST' });
    network.clearSocketAuth();
    ui.resetToGuestProfile(guestProfileId);
    if (network.connected) network.requestProfile(guestProfileId, ui.playerName);
  },
  onRefreshWallet: () => refreshWallet(),
  onBotDifficultyChange: (botDifficulty) => {
    if (network.connected && currentRoom?.mode === 'SOLO_VS_BOTS') {
      network.setBotDifficulty(botDifficulty);
    }
  },
  onPlayNow: (name, bundleId, id, mapId, botDifficulty) => {
    if (!network.connected) {
      ui.clearAction();
      ui.showError('Still connecting to the game server. Try again in a moment.');
      return;
    }
    unlockAudio();
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.()?.catch?.(() => {});
    }
    network.playNow(name, bundleId, id, mapId, botDifficulty ?? ui.botDifficulty);
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
  onStart: () => {
    unlockAudio();
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.()?.catch?.(() => {});
    }
    network.startGame();
  },
  onReturnToLobby: () => network.returnToLobby(),
  onPlayAgain: () => {
    if (!network.connected) {
      ui.showError('Still reconnecting to the game server. Try again in a moment.');
      return;
    }
    unlockAudio();
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.()?.catch?.(() => {});
    }
    network.playAgain(ui.botDifficulty);
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

controller.onInputEdge = () => {
  if (controller.enabled) sendCurrentInput(true);
};

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
    audio.setAmbience(null);
    trigger.release();
    releaseRightAction();
    closeWeaponWheel(false);
    controller.reset();
    sendNeutralInput();
  } else if (matchActive && !matchEnded && world.map) {
    audio.setAmbience(world.map.scenery?.style ?? 'foundry');
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
      weaponEffects.setBlocking(true);
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
window.addEventListener('keydown', (event) => {
  if (event.code === 'Tab' && !event.repeat) syncInputState();
});

window.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
  if (controller.isTyping(event.target)) return;

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

/**
 * Non-destructive frame sample for local prediction: never burns network `seq`
 * numbers and never clears `jumpTapLatched` before a packet is sent.
 */
function sampleLocalInput() {
  const active = latestPlayerAlive && controller.enabled && document.pointerLockElement === canvas;
  const forward = active
    ? Number(controller.keys.has('KeyW') || controller.keys.has('ArrowUp'))
      - Number(controller.keys.has('KeyS') || controller.keys.has('ArrowDown'))
    : 0;
  const strafe = active
    ? Number(controller.keys.has('KeyD') || controller.keys.has('ArrowRight'))
      - Number(controller.keys.has('KeyA') || controller.keys.has('ArrowLeft'))
    : 0;
  const jump = active
    ? (controller.keys.has('Space') || controller.jumpTapLatched)
    : false;
  return {
    seq: Math.max(1, inputSequence),
    forward,
    strafe,
    jump,
    yaw: controller.yaw,
    pitch: controller.pitch,
    blocking: Boolean(rightMouseHeld && active && latestLocalPlayer?.currentWeaponId === 'COMBAT_SHIELD'),
  };
}

function buildNetworkInput(now = performance.now()) {
  const seq = ++inputSequence;
  const input = controller.getInput(seq, { consumeJumpTap: true });
  if (!latestPlayerAlive) {
    input.forward = 0;
    input.strafe = 0;
    input.jump = false;
  }
  input.blocking = Boolean(rightMouseHeld && controller.enabled && latestLocalPlayer?.currentWeaponId === 'COMBAT_SHIELD');
  diagnostics.recordInputSent(seq, now);
  return input;
}

function sendNeutralInput() {
  if (!network.connected || !canPlay()) return;
  const now = performance.now();
  const input = buildNetworkInput(now);
  input.forward = 0;
  input.strafe = 0;
  input.jump = false;
  input.blocking = false;
  network.sendInput(input, true);
  inputCadence.sent(input, now);
}

function sendCurrentInput(reliable = false, now = performance.now()) {
  if (!network.connected || !canPlay()) return;
  const input = buildNetworkInput(now);
  network.sendInput(input, reliable);
  inputCadence.sent(input, now);
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
  sendCurrentInput(true, now);
  const shotId = nextShotId++;
  predictedShots.remember(shotId, now);
  diagnostics.recordShotSent(now);
  network.shoot(shotId);
  weaponEffects.presentFire(now, weaponId, latestLocalPlayer.bundleId);
  audio.play('shot', { weaponId, weaponClass: weaponEffects.weaponClass });
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
  const frameElapsedMs = Math.max(0, now - lastFrameTime);
  const frameElapsed = frameElapsedMs / 1000;
  const delta = Math.min(frameElapsed, 0.1);
  lastFrameTime = now;
  diagnostics.recordFrame(frameElapsed);

  if (!matchActive && menuStage?.built && !menuStage.visible) menuStage.show();

  if (matchActive) {
    const reducedMotion = settings.snapshot.reducedMotion === true;
    world.update(now, delta, { reducedMotion });

    let activeInput = { forward: 0, strafe: 0, jump: false };
    if (canPlay() && network.connected) {
      activeInput = sampleLocalInput();
      if (latestPlayerAlive) prediction.step(activeInput, delta, world.map, predictionCover);
    }

    const predState = prediction.state ?? latestLocalPlayer;
    const localSpeed = latestPlayerAlive && predState
      ? Math.hypot(predState.vx ?? 0, predState.vz ?? 0)
      : 0;
    const predVy = latestPlayerAlive && predState ? (predState.vy ?? 0) : 0;
    const nowGrounded = !latestPlayerAlive || !predState ? true : predState.grounded !== false;

    if (latestPlayerAlive) {
      if (wasLocalGrounded && !nowGrounded && predVy > 2.2) {
        audio.play('jump');
      } else if (!wasLocalGrounded && nowGrounded && lastAirborneVy < -1.8) {
        const impactSpeed = Math.abs(lastAirborneVy);
        const dipScale = reducedMotion ? 0.15 : 1;
        cameraLandingDip = Math.min(0.046, Math.max(0.010, impactSpeed * 0.0046)) * dipScale;
        weaponEffects.triggerLanding(impactSpeed);
        audio.play('land', { intensity: impactSpeed / 6.5 });
      }
      if (!nowGrounded) {
        lastAirborneVy = Math.min(lastAirborneVy, predVy);
      } else {
        lastAirborneVy = 0;
      }
      wasLocalGrounded = nowGrounded;
    }

    const moveNorm = Math.min(1, localSpeed / PLAYER.speed);
    if (latestPlayerAlive && nowGrounded && moveNorm > 0.22) {
      const prevSin = Math.sin(cameraStridePhase);
      cameraStridePhase += delta * (4.6 + moveNorm * 6.8);
      const nextSin = Math.sin(cameraStridePhase);
      if ((prevSin >= 0 && nextSin < 0) || (prevSin <= 0 && nextSin > 0)) {
        audio.play('step');
      }
    }

    const motionComfortScale = (reducedMotion ? 0.12 : 1) * (1 - aim.amount * 0.82);
    const targetBobX = (nowGrounded && moveNorm > 0.05)
      ? Math.cos(cameraStridePhase) * 0.0065 * moveNorm * motionComfortScale
      : 0;
    const targetBobY = (nowGrounded && moveNorm > 0.05)
      ? -Math.abs(Math.sin(cameraStridePhase)) * 0.0135 * moveNorm * motionComfortScale
      : 0;
    const smoothBob = 1 - Math.exp(-15 * delta);
    cameraBobX += (targetBobX - cameraBobX) * smoothBob;
    cameraBobY += (targetBobY - cameraBobY) * smoothBob;
    if (Math.abs(cameraBobX) < 1e-5) cameraBobX = 0;
    if (Math.abs(cameraBobY) < 1e-5) cameraBobY = 0;

    cameraLandingDip *= Math.exp(-15 * delta);
    if (cameraLandingDip < 1e-4) cameraLandingDip = 0;

    const targetRoll = (latestPlayerAlive && !reducedMotion)
      ? -activeInput.strafe * 0.0052 * (1 - aim.amount * 0.85)
      : 0;
    cameraStrafeRoll += (targetRoll - cameraStrafeRoll) * (1 - Math.exp(-12 * delta));
    if (Math.abs(cameraStrafeRoll) < 1e-5) cameraStrafeRoll = 0;

    const lookDelta = controller.consumeLookDelta();
    weaponEffects.setMotionState({
      speed: localSpeed,
      forward: activeInput.forward,
      strafe: activeInput.strafe,
      vy: predVy,
      grounded: nowGrounded,
      lookYawDelta: lookDelta.yaw,
      lookPitchDelta: lookDelta.pitch,
      reducedMotion,
    });

    camera.rotation.order = 'YXZ';
    camera.rotation.y = controller.yaw;
    camera.rotation.x = controller.pitch;
    camera.rotation.z = cameraStrafeRoll;
    const renderAt = now - interpolator.delayMs;
    const localPose = prediction.sample(delta) ?? latestLocalPlayer;
    if (localPose) {
      const rightX = Math.cos(controller.yaw);
      const rightZ = -Math.sin(controller.yaw);
      camera.position.set(
        localPose.x + rightX * cameraBobX,
        localPose.y + PLAYER.eyeHeight + cameraBobY - cameraLandingDip,
        localPose.z + rightZ * cameraBobX,
      );
    }
    camera.updateMatrixWorld(true);
    remotePlayers.update(latestPlayers, interpolator, camera, renderAt, network.id);
    combatIntel.update(latestPlayers, interpolator, camera, renderAt, network.id, predictionCover, now, intelSmoke);
  }

  weaponEffects.setVisible(matchActive && !matchEnded);
  if (menuStage?.built) {
    if (matchActive) menuStage.hide();
    menuStage.update(delta);
  }
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

console.info(`[FPS GODS] Socket.IO target: ${network.connectionTarget.url} (source: ${network.connectionTarget.source})`);

window.addEventListener('beforeunload', () => {
  stopPingLoop();
  trigger.release();
  controller.dispose();
  weaponEffects.dispose();
  remotePlayers.clear();
  combatIntel.clear();
  menuStage?.dispose();
  weaponModels.dispose();
  world.dispose();
  assetManager.dispose();
  audio.dispose();
  ui.dispose();
  network.disconnect?.();
});
