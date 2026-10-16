import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { GameNetwork } from './network.js';
import { PlayerController, RemotePlayers, StateInterpolator } from './player.js';
import { World } from './world.js';
import { WeaponEffects } from './weapons.js';
import { GameUI } from './ui.js';

const canvas = document.querySelector('#game-canvas');
const ui = new GameUI();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(77, window.innerWidth / window.innerHeight, 0.05, 125);
camera.rotation.order = 'YXZ';
scene.add(camera);

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
} catch (error) {
  console.warn('WebGL renderer could not be initialized:', error);
  ui.showWebGLWarning();
}

const world = new World(scene);
const controller = new PlayerController(camera, canvas);
const nameTagRoot = document.querySelector('#name-tags');
const remotePlayers = new RemotePlayers(scene, nameTagRoot);
const interpolator = new StateInterpolator();
const weaponEffects = new WeaponEffects(scene, camera);

let currentRoom = null;
let matchActive = false;
let matchEnded = false;
let isShooting = false;
let nextClientShotAt = 0;
let inputSequence = 0;
let latestPlayers = [];
let latestLocalPlayer = null;
let serverClockOffset = 0;
let latestPlayerAlive = false;

function canPlay() {
  return matchActive && !matchEnded && currentRoom?.state === 'PLAYING';
}

function clearMatchPresentation() {
  matchActive = false;
  matchEnded = false;
  isShooting = false;
  nextClientShotAt = 0;
  latestPlayers = [];
  latestLocalPlayer = null;
  latestPlayerAlive = false;
  interpolator.clear();
  remotePlayers.clear();
  controller.setEnabled(false);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.setScoreboard(false);
}

function enterMatch(room = currentRoom) {
  if (!room) return;
  currentRoom = room;
  if (!matchActive || matchEnded) {
    matchActive = true;
    matchEnded = false;
    latestPlayers = [];
    latestLocalPlayer = null;
    latestPlayerAlive = false;
    interpolator.clear();
    remotePlayers.clear();
    nextClientShotAt = 0;
  }
  ui.showMatch(room);
  controller.setEnabled(document.pointerLockElement === canvas);
  ui.setPaused(document.pointerLockElement !== canvas);
}

// Shown once when a production build has no VITE_SOCKET_URL baked in, so the
// failure reads as a deployment configuration problem instead of a timeout.
let reportedMissingServerUrl = false;

const network = new GameNetwork({
  onConnect: () => ui.setConnectionState('connected'),
  onDisconnect: (reason) => {
    ui.setConnectionState('offline');
    if (reason !== 'io client disconnect') ui.showToast('Connection interrupted. Trying to reconnect…');
    controller.setEnabled(false);
    isShooting = false;
  },
  onConnectionError: () => {
    if (network.missingServerUrl && !reportedMissingServerUrl) {
      reportedMissingServerUrl = true;
      ui.setConnectionState('offline', 'No multiplayer server in this build. Set VITE_SOCKET_URL, then redeploy.');
      return;
    }
    ui.setConnectionState('offline');
  },
  onRoomState: (room) => {
    const previousState = currentRoom?.state;
    currentRoom = room;
    ui.setRoom(room, network.id);

    if (room.state === 'PLAYING') {
      enterMatch(room);
    } else if (room.state === 'LOBBY') {
      if (previousState === 'PLAYING' || previousState === 'ENDED' || matchActive) clearMatchPresentation();
      currentRoom = room;
      ui.showLobby(room, network.id);
    } else if (room.state === 'ENDED') {
      matchEnded = true;
      isShooting = false;
      controller.setEnabled(false);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
  },
  onRoomError: (error) => ui.showError(error?.message),
  onGameStart: () => enterMatch(currentRoom),
  onGameState: (state) => {
    if (!matchActive || state.code !== currentRoom?.code) return;
    const receivedAt = performance.now();
    latestPlayers = state.players ?? [];
    interpolator.push(latestPlayers, receivedAt);
    serverClockOffset = (state.serverTime ?? Date.now()) - Date.now();
    latestLocalPlayer = latestPlayers.find((player) => player.id === network.id) ?? null;
    latestPlayerAlive = Boolean(latestLocalPlayer?.alive);
    if (latestLocalPlayer) {
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
    }
    ui.updateScoreboard(latestPlayers, network.id);
  },
  onGameEnd: (result) => {
    matchEnded = true;
    isShooting = false;
    controller.setEnabled(false);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    ui.showGameEnd(result, network.id);
  },
  onReturnToLobby: () => {
    clearMatchPresentation();
    if (currentRoom) ui.showLobby(currentRoom, network.id);
  },
  onPlayerDied: (data) => {
    if (data.victimId === network.id && latestLocalPlayer) {
      latestLocalPlayer.alive = false;
      latestLocalPlayer.health = 0;
      latestLocalPlayer.respawnAt = data.respawnAt;
      latestPlayerAlive = false;
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
    }
  },
  onPlayerRespawned: (data) => {
    if (data.id === network.id) ui.showToast('Re-deployed. Two seconds of spawn protection.');
  },
  onKillFeed: (entry) => ui.addKillFeed(entry, network.id),
  onScoreUpdate: (data) => ui.updateScoreboard(data?.players, network.id),
  onHitConfirmed: (hit) => ui.showHitMarker(hit),
  onAmmoUpdate: (data) => {
    if (!latestLocalPlayer) return;
    Object.assign(latestLocalPlayer, data);
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
  },
  onHealthUpdate: (data) => {
    if (!latestLocalPlayer) return;
    latestLocalPlayer.health = data.health;
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
  },
});

ui.setHandlers({
  onCreate: (name) => {
    if (!network.connected) return ui.showError('Still connecting to the game server. Try again in a moment.');
    network.createRoom(name);
  },
  onJoin: (name, code) => {
    if (!network.connected) return ui.showError('Still connecting to the game server. Try again in a moment.');
    network.joinRoom(code, name);
  },
  onReady: (ready) => network.setReady(ready),
  onStart: () => network.startGame(),
  onReturnToLobby: () => network.returnToLobby(),
  onResume: () => {
    if (canPlay() && document.pointerLockElement !== canvas) {
      const request = canvas.requestPointerLock?.();
      request?.catch?.(() => ui.showToast('Click the arena again to enable pointer lock.'));
    }
  },
});

// The player can only look/fire while pointer-locked. Movement packets are
// still sent every rendered frame, but become neutral when the game is paused.
canvas.addEventListener('click', () => {
  if (canPlay() && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  controller.setEnabled(locked && canPlay());
  if (!locked) isShooting = false;
  if (canPlay()) ui.setPaused(!locked);
});

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !canPlay() || document.pointerLockElement !== canvas || !latestPlayerAlive) return;
  isShooting = true;
  fireOnce(performance.now());
});
document.addEventListener('mouseup', (event) => {
  if (event.button === 0) isShooting = false;
});
window.addEventListener('blur', () => { isShooting = false; });
window.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyR' || event.repeat || !canPlay() || document.pointerLockElement !== canvas) return;
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  event.preventDefault();
  network.reload();
});

function fireOnce(now) {
  if (!canPlay() || !latestPlayerAlive || !latestLocalPlayer || latestLocalPlayer.reloading || latestLocalPlayer.ammo <= 0 || document.pointerLockElement !== canvas || now < nextClientShotAt) return;
  nextClientShotAt = now + PLAYER.fireIntervalMs;
  network.shoot();
  weaponEffects.fire(now);
}

function resize() {
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
}
window.addEventListener('resize', resize);

// Render the arena as a slow orbit while players are in menus. During matches,
// the local camera position is interpolated from authoritative server snapshots.
function animate(now = performance.now()) {
  requestAnimationFrame(animate);

  if (matchActive) {
    if (canPlay() && network.connected) {
      const input = controller.getInput(inputSequence++);
      if (!latestPlayerAlive) {
        input.forward = 0;
        input.strafe = 0;
        input.jump = false;
      }
      network.sendInput(input);
      if (isShooting && now >= nextClientShotAt) fireOnce(now);
    }

    camera.rotation.order = 'YXZ';
    camera.rotation.y = controller.yaw;
    camera.rotation.x = controller.pitch;
    camera.rotation.z = 0;
    const renderAt = now - 90;
    const localPose = network.id ? interpolator.sample(network.id, renderAt) : null;
    if (localPose) camera.position.set(localPose.x, localPose.y + PLAYER.eyeHeight, localPose.z);
    camera.updateMatrixWorld(true);
    remotePlayers.update(latestPlayers, interpolator, camera, renderAt, network.id);
  } else {
    const orbit = now * 0.000035;
    camera.position.set(Math.sin(orbit) * 31, 22 + Math.sin(orbit * 0.7) * 1.3, Math.cos(orbit) * 31);
    camera.lookAt(0, 0.65, 0);
  }

  weaponEffects.gun.visible = matchActive && !matchEnded;
  if (renderer) renderer.render(scene, camera);
  weaponEffects.update(now);
}
requestAnimationFrame(animate);
