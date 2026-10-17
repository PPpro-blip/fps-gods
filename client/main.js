import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { getWeapon } from '../shared/weapons.js';
import { GameNetwork } from './network.js';
import { PlayerController, RemotePlayers, StateInterpolator } from './player.js';
import { SmokeClouds, World } from './world.js';
import { WeaponViewmodels } from './weapons.js';
import { addLifetimeKills, GameUI, getLifetimeKills } from './ui.js';

// Every error that escapes to the browser console is tagged so deployment
// issues on Vercel/Railway are easy to spot.
window.addEventListener('error', (event) => {
  console.error('[FPS GODS] Uncaught error:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[FPS GODS] Unhandled rejection:', event.reason);
});

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
const smokeClouds = new SmokeClouds(scene);
const controller = new PlayerController(camera, canvas);
const nameTagRoot = document.querySelector('#name-tags');
const remotePlayers = new RemotePlayers(scene, nameTagRoot);
const interpolator = new StateInterpolator();
const viewmodels = new WeaponViewmodels(camera, scene);
viewmodels.load().then(() => {
  viewmodels.setWeapon('pistol', { instant: true });
  viewmodels.setVisible(false);
}).catch((error) => console.error('[FPS GODS] Viewmodel preload failed:', error));

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
let latestWeaponId = null;
let recordedMatchKills = false;

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
  latestWeaponId = null;
  recordedMatchKills = false;
  interpolator.clear();
  remotePlayers.clear();
  smokeClouds.sync([]);
  controller.setEnabled(false);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.setScoreboard(false);
  ui.closeWeaponWheel();
  viewmodels.setVisible(false);
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
    latestWeaponId = null;
    recordedMatchKills = false;
    interpolator.clear();
    remotePlayers.clear();
    nextClientShotAt = 0;
  }
  ui.showMatch(room);
  controller.setEnabled(document.pointerLockElement === canvas);
  ui.setPaused(document.pointerLockElement !== canvas);
  viewmodels.setVisible(true);
}

function activeWeaponDefinition() {
  return getWeapon(latestLocalPlayer?.weaponId ?? latestWeaponId ?? 'pistol');
}

const network = new GameNetwork({
  onConnect: () => ui.setConnectionState('connected'),
  onDisconnect: (reason) => {
    ui.setConnectionState('offline');
    if (reason !== 'io client disconnect') ui.showToast('Connection lost. Retrying every 3 seconds…');
    controller.setEnabled(false);
    isShooting = false;
  },
  onConnectionError: (error) => {
    console.error('[FPS GODS] Could not reach game server at', network.serverUrl, error?.message ?? error);
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
    smokeClouds.sync(state.smokes ?? [], state.serverTime ?? Date.now());
    serverClockOffset = (state.serverTime ?? Date.now()) - Date.now();
    latestLocalPlayer = latestPlayers.find((player) => player.id === network.id) ?? null;
    latestPlayerAlive = Boolean(latestLocalPlayer?.alive);
    if (latestLocalPlayer) {
      if (latestLocalPlayer.weaponId !== latestWeaponId) {
        latestWeaponId = latestLocalPlayer.weaponId;
        viewmodels.setWeapon(latestWeaponId ?? 'pistol');
      }
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
    }
    ui.updateScoreboard(latestPlayers, network.id);
  },
  onGameEnd: (result) => {
    matchEnded = true;
    isShooting = false;
    controller.setEnabled(false);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (!recordedMatchKills) {
      recordedMatchKills = true;
      const mine = result?.scoreboard?.find((player) => player.id === network.id);
      if (mine?.kills) {
        const total = addLifetimeKills(mine.kills);
        ui.showToast(`+${mine.kills} lifetime kills. Total: ${total}`);
      }
    }
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
      isShooting = false;
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
    if (data.weaponId && data.weaponId !== latestWeaponId) {
      latestWeaponId = data.weaponId;
      viewmodels.setWeapon(data.weaponId);
    }
    if (data.reloading) {
      viewmodels.startReload(getWeapon(data.weaponId ?? latestWeaponId ?? 'pistol').reloadMs);
    }
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
  },
  onHealthUpdate: (data) => {
    if (!latestLocalPlayer) return;
    latestLocalPlayer.health = data.health;
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive).length);
  },
  onWeaponSwitched: (data) => {
    if (data?.weaponId) viewmodels.setWeapon(data.weaponId);
  },
});

ui.setHandlers({
  onBundleConfirmed: (bundleId, action, code) => {
    if (!network.connected) {
      ui.showError('Still connecting to the game server. Try again in a moment.');
      return;
    }
    const name = ui.playerName;
    const kills = getLifetimeKills();
    if (action === 'solo') {
      network.playSolo(name, bundleId, kills);
    } else if (action === 'create') {
      network.createRoom(name, bundleId, kills);
    } else {
      network.joinRoom(code, name, bundleId, kills);
    }
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
  controller.setEnabled(locked && canPlay() && !ui.wheelOpen);
  if (!locked) isShooting = false;
  if (canPlay()) ui.setPaused(!locked && !ui.wheelOpen);
});

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !canPlay() || document.pointerLockElement !== canvas || !latestPlayerAlive || ui.wheelOpen) return;
  isShooting = true;
  fireOnce(performance.now());
});
document.addEventListener('mouseup', (event) => {
  if (event.button === 0) isShooting = false;
});
window.addEventListener('blur', () => { isShooting = false; });
window.addEventListener('contextmenu', (event) => event.preventDefault());

// While the weapon wheel is open, raw mouse motion drives the wheel selector
// instead of the camera; releasing Q equips the highlighted weapon.
window.addEventListener('mousemove', (event) => {
  if (ui.wheelOpen) ui.moveWeaponWheel(event.movementX ?? 0, event.movementY ?? 0);
});

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
  if (typing) return;

  if (event.code === 'KeyR' && !event.repeat && canPlay() && document.pointerLockElement === canvas) {
    event.preventDefault();
    network.reload();
    return;
  }

  if (event.code === 'KeyQ' && !event.repeat && canPlay()) {
    event.preventDefault();
    const slots = latestLocalPlayer
      ? bundleSlotsFor(latestLocalPlayer)
      : [{ weaponId: 'pistol' }, { weaponId: 'smg' }, { weaponId: 'knife' }];
    ui.openWeaponWheel(slots, latestLocalPlayer?.slot ?? 0);
    controller.setEnabled(false);
    isShooting = false;
    ui.setPaused(false);
    return;
  }

  // Number keys mirror the wheel for players who prefer direct selection.
  if (['Digit1', 'Digit2', 'Digit3'].includes(event.code) && !event.repeat && canPlay() && latestLocalPlayer) {
    event.preventDefault();
    requestWeaponSwitch(Number(event.code.slice(-1)) - 1);
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code !== 'KeyQ' || !ui.wheelOpen) return;
  event.preventDefault();
  const selected = ui.closeWeaponWheel();
  if (selected !== null && latestLocalPlayer) requestWeaponSwitch(selected);
  if (canPlay()) {
    controller.setEnabled(document.pointerLockElement === canvas);
    ui.setPaused(document.pointerLockElement !== canvas);
  }
});

function bundleSlotsFor(player) {
  // The three slots come straight from the player's bundle; the server echoes
  // them one by one via state, but the shared catalog keeps the wheel instant.
  const bundleSlots = {
    rusher: ['smg', 'shotgun', 'knife'],
    ghost: ['pistol', 'sniper', 'smoke'],
    heavy: ['lmg', 'rocket', 'shield'],
    gods: ['railgun', 'minigun', 'fist'],
  };
  return (bundleSlots[player.bundleId] ?? bundleSlots.rusher).map((weaponId) => ({ weaponId }));
}

function requestWeaponSwitch(slot) {
  if (!latestLocalPlayer || slot === latestLocalPlayer.slot) return;
  network.switchWeapon(slot);
  const slots = bundleSlotsFor(latestLocalPlayer);
  const weaponId = slots[slot]?.weaponId;
  if (weaponId) {
    viewmodels.setWeapon(weaponId);
    latestWeaponId = weaponId;
  }
}

function fireOnce(now) {
  if (!canPlay() || !latestPlayerAlive || !latestLocalPlayer || latestLocalPlayer.reloading || document.pointerLockElement !== canvas || now < nextClientShotAt) return;
  const weapon = activeWeaponDefinition();
  if (latestLocalPlayer.overheated) return;
  if (!weapon.unlimited && weapon.magSize > 0 && (latestLocalPlayer.ammo ?? 0) <= 0) return;

  nextClientShotAt = now + weapon.fireRateMs;
  network.shoot();
  viewmodels.fire(now);
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
  const deltaSeconds = Math.min(0.05, (now - (animate.lastFrame ?? now)) / 1_000);
  animate.lastFrame = now;

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
    camera.updateMatrixWorld(true);
  }

  viewmodels.setVisible(matchActive && !matchEnded && Boolean(latestLocalPlayer));
  const movingSpeed = latestLocalPlayer?.alive
    ? Math.hypot(latestLocalPlayer.vx ?? 0, latestLocalPlayer.vz ?? 0)
    : 0;
  if (renderer) renderer.render(scene, camera);
  viewmodels.update(now, deltaSeconds, { movingSpeed });
  smokeClouds.update(now);
}
requestAnimationFrame(animate);
