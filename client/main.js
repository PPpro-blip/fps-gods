import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { BUNDLE_BY_ID } from '../shared/bundles.js';
import { GameNetwork } from './network.js';
import { PlayerController, RemotePlayers, StateInterpolator } from './player.js';
import { World } from './world.js';
import { WeaponEffects, WeaponModelLibrary } from './weapons.js';
import { GameUI } from './ui.js';
import { WeaponTrigger } from './trigger.js';
import { LobbyScene } from './LobbyScene.js';
import { assetManager } from './AssetManager.js';

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
      && typeof session.resumeToken === 'string' && /^[A-Za-z0-9_-]{40,48}$/.test(session.resumeToken)) return session;
  } catch {
    localStorage.removeItem('fps-gods-room-session');
  }
  return null;
}

function clearRoomSession() {
  localStorage.removeItem('fps-gods-room-session');
}

const canvas = document.querySelector('#game-canvas');
const profileId = getOrCreateProfileId();
const urlParams = new URLSearchParams(window.location.search);
const roomCodeFromUrl = urlParams.get('room');
const ui = new GameUI({ profileId });

// Initialize asset manager and lobby scene
let lobbyScene = null;
let assetsLoaded = false;

// Start loading assets
assetManager.init().then(() => {
  assetsLoaded = true;
  console.log('[FPS GODS] Assets loaded successfully');
}).catch((error) => {
  console.error('[FPS GODS] Failed to load assets:', error);
});
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

// Initialize lobby scene after assets are loaded
setTimeout(() => {
  if (assetsLoaded) {
    lobbyScene = new LobbyScene(scene, camera);
  }
}, 100);
const weaponModels = new WeaponModelLibrary();
const remotePlayers = new RemotePlayers(scene, nameTagRoot, weaponModels);
const interpolator = new StateInterpolator();
const weaponEffects = new WeaponEffects(scene, camera, weaponModels);
weaponModels.ready.then((loaded) => {
  if (!loaded) ui.showToast('One or more weapon models could not be loaded. Check the game asset files.');
});

let currentRoom = null;
let matchActive = false;
let matchEnded = false;
const trigger = new WeaponTrigger();
let weaponWheelOpen = false;
let wheelPointer = { x: 0, y: 0 };
let nextClientShotAt = 0;
let inputSequence = 0;
let latestPlayers = [];
let latestLocalPlayer = null;
let serverClockOffset = 0;
let latestPlayerAlive = false;

function canPlay() {
  return matchActive && !matchEnded && currentRoom?.state === 'PLAYING';
}

function closeWeaponWheel(equip = true) {
  if (!weaponWheelOpen) return;
  const selectedWeaponId = ui.closeWeaponWheel();
  weaponWheelOpen = false;
  wheelPointer = { x: 0, y: 0 };
  controller.setEnabled(document.pointerLockElement === canvas && canPlay());
  if (equip && selectedWeaponId && latestLocalPlayer
    && selectedWeaponId !== latestLocalPlayer.currentWeaponId && network.connected) {
    network.switchWeapon(selectedWeaponId);
  }
}

function clearMatchPresentation() {
  matchActive = false;
  matchEnded = false;
  trigger.release();
  closeWeaponWheel(false);
  nextClientShotAt = 0;
  latestPlayers = [];
  latestLocalPlayer = null;
  latestPlayerAlive = false;
  trigger.sync(null, false);
  interpolator.clear();
  remotePlayers.clear();
  weaponEffects.updateSmokeClouds([]);
  world.resetCover();
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
    weaponEffects.updateSmokeClouds([]);
    world.resetCover();
    nextClientShotAt = 0;
  }
  ui.showMatch(room);
  controller.setEnabled(document.pointerLockElement === canvas);
  ui.setPaused(document.pointerLockElement !== canvas);
}

let autoJoinAttempted = false;

const network = new GameNetwork({
  onConnect: (_socketId, recovered) => {
    ui.setConnectionState('connected');
    network.requestProfile(profileId, ui.playerName);
    if (!recovered) network.resumeRoom(readRoomSession());
    // Auto-join from URL parameter if present
    if (roomCodeFromUrl && ui.playerName && !autoJoinAttempted) {
      autoJoinAttempted = true;
      setTimeout(() => {
        network.joinRoom(roomCodeFromUrl, ui.playerName, ui.bundleId, profileId);
      }, 500);
    }
  },
  onDisconnect: (reason) => {
    ui.setConnectionState('offline');
    if (reason !== 'io client disconnect') ui.showToast('Connection interrupted. Trying to reconnect…');
    controller.setEnabled(false);
    trigger.release();
    closeWeaponWheel(false);
  },
  onConnectionError: () => ui.setConnectionState('offline'),
  onProfileUpdate: (profile) => ui.setProfile(profile),
  onRoomSession: (session) => localStorage.setItem('fps-gods-room-session', JSON.stringify(session)),
  onRoomResumeFailed: (error) => {
    clearRoomSession();
    currentRoom = null;
    if (matchActive) clearMatchPresentation();
    ui.setRoom(null, network.id);
    ui.showHome();
    ui.showToast(error?.message ?? 'The previous room session has expired.');
  },
  onRoomLeft: () => {
    clearRoomSession();
    currentRoom = null;
    clearMatchPresentation();
    ui.setRoom(null, network.id);
    ui.showHome();
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
      trigger.release();
      closeWeaponWheel(false);
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
    trigger.sync(latestLocalPlayer?.currentWeaponId, latestLocalPlayer?.auto);
    world.updateCover(state.cover);
    weaponEffects.updateSmokeClouds(state.smokeClouds ?? []);
    if (latestLocalPlayer) {
      weaponEffects.setWeapon(latestLocalPlayer.currentWeaponId, latestLocalPlayer.bundleId);
      weaponEffects.setMovementSpeed(Math.hypot(latestLocalPlayer.vx ?? 0, latestLocalPlayer.vz ?? 0));
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive && player.connected !== false).length);
    }
    ui.updateScoreboard(latestPlayers, network.id);
  },
  onGameEnd: (result) => {
    matchEnded = true;
    trigger.release();
    closeWeaponWheel(false);
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
      trigger.release();
      closeWeaponWheel(false);
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive && player.connected !== false).length);
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
    trigger.sync(latestLocalPlayer.currentWeaponId, latestLocalPlayer.auto);
    weaponEffects.setWeapon(latestLocalPlayer.currentWeaponId, latestLocalPlayer.bundleId);
    if (data.reloading) {
      weaponEffects.startReload((data.reloadCompletesAt ?? Date.now() + 900) - (Date.now() + serverClockOffset));
    }
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive && player.connected !== false).length);
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
      });
      trigger.sync(data.weaponId, data.auto);
      weaponEffects.setWeapon(data.weaponId, data.bundleId);
      ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((candidate) => candidate.alive && candidate.connected !== false).length);
    }
  },
  onWeaponOverheated: (data) => {
    if (data.weaponId === latestLocalPlayer?.currentWeaponId) ui.showToast('MINIGUN OVERHEATED — cooling down.');
  },
  onWeaponFired: (data) => {
    if (data.playerId === network.id) {
      weaponEffects.fire(performance.now(), data.weaponId, data.bundleId, data);
      return;
    }
    remotePlayers.flashWeapon(data.playerId, data.weaponId, data.bundleId);
    weaponEffects.showRemoteTracer(data);
  },
  onSmokeUpdate: (data) => weaponEffects.updateSmokeClouds(data.smokeClouds ?? []),
  onCoverDestroyed: (data) => world.destroyCover(data.blockId),
  onHealthUpdate: (data) => {
    if (!latestLocalPlayer) return;
    latestLocalPlayer.health = data.health;
    ui.updateHud(latestLocalPlayer, Date.now() + serverClockOffset, latestPlayers.filter((player) => player.alive && player.connected !== false).length);
  },
});

ui.setHandlers({
  onCallsignContinue: (name, id) => {
    if (network.connected) network.requestProfile(id, name);
  },
  onPlayNow: (name, bundleId, id) => {
    if (!network.connected) return ui.showError('Still connecting to the game server. Try again in a moment.');
    network.playNow(name, bundleId, id);
  },
  onCreate: (name, bundleId, id) => {
    if (!network.connected) return ui.showError('Still connecting to the game server. Try again in a moment.');
    network.createRoom(name, bundleId, id);
  },
  onJoin: (name, code, bundleId, id) => {
    if (!network.connected) return ui.showError('Still connecting to the game server. Try again in a moment.');
    network.joinRoom(code, name, bundleId, id);
  },
  onJoinFromUrl: (name, code, bundleId, id) => {
    if (!network.connected) return;
    network.joinRoom(code, name, bundleId, id);
  },
  onLeaveRoom: () => network.leaveRoom(),
  onReady: (ready) => network.setReady(ready),
  onStart: () => network.startGame(),
  onReturnToLobby: () => network.returnToLobby(),
  onPlayAgain: () => {
    if (!network.connected) return ui.showError('Still reconnecting to the game server. Try again in a moment.');
    network.playAgain();
  },
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
  controller.setEnabled(locked && canPlay() && !weaponWheelOpen);
  if (!locked) {
    trigger.release();
    closeWeaponWheel(false);
  }
  if (canPlay()) ui.setPaused(!locked);
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
  if (event.button !== 0 || !canPlay() || weaponWheelOpen
    || document.pointerLockElement !== canvas || !latestPlayerAlive) return;
  trigger.press();
  fireOnce(performance.now());
});
document.addEventListener('mouseup', (event) => {
  if (event.button === 0) trigger.release();
});
window.addEventListener('blur', () => {
  trigger.release();
  closeWeaponWheel(false);
});
window.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (event.code === 'KeyQ' && !event.repeat && canPlay() && latestPlayerAlive
    && document.pointerLockElement === canvas) {
    event.preventDefault();
    weaponWheelOpen = true;
    wheelPointer = { x: 0, y: 0 };
    trigger.release();
    ui.openWeaponWheel(latestLocalPlayer?.bundleId, latestLocalPlayer?.currentWeaponId);
    controller.setEnabled(false);
    return;
  }
  if (event.code !== 'KeyR' || event.repeat || !canPlay()
    || document.pointerLockElement !== canvas || weaponWheelOpen) return;
  event.preventDefault();
  weaponEffects.startReload();
  network.reload();
});

// Mouse scroll weapon cycling
document.addEventListener('wheel', (event) => {
  if (!canPlay() || weaponWheelOpen || !latestPlayerAlive
    || document.pointerLockElement !== canvas) return;
  
  const deltaY = controller.getWheelDelta();
  if (deltaY === 0) return;
  
  event.preventDefault();
  
  // Get current bundle weapons
  const bundleId = latestLocalPlayer?.bundleId;
  if (!bundleId) return;
  
  const bundle = BUNDLE_BY_ID[bundleId];
  if (!bundle) return;
  
  const weapons = bundle.weapons;
  const currentIndex = weapons.findIndex(w => w.id === latestLocalPlayer?.currentWeaponId);
  
  if (currentIndex === -1) return;
  
  // Scroll down (deltaY > 0) cycles forward
  // Scroll up (deltaY < 0) cycles backward
  let nextIndex;
  if (deltaY > 0) {
    nextIndex = (currentIndex + 1) % weapons.length;
  } else {
    nextIndex = (currentIndex - 1 + weapons.length) % weapons.length;
  }
  
  const nextWeaponId = weapons[nextIndex].id;
  if (nextWeaponId && nextWeaponId !== latestLocalPlayer?.currentWeaponId && network.connected) {
    network.switchWeapon(nextWeaponId);
    // Require fresh click to fire after weapon swap
    trigger.release();
    trigger.sync(nextWeaponId, false);
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'KeyQ') closeWeaponWheel(true);
});

function fireOnce(now) {
  if (!canPlay() || weaponWheelOpen || !latestPlayerAlive || !latestLocalPlayer
    || latestLocalPlayer.reloading || latestLocalPlayer.overheated
    || (latestLocalPlayer.maxAmmo > 0 && latestLocalPlayer.ammo <= 0)
    || latestLocalPlayer.currentWeaponId === 'COMBAT_SHIELD'
    || document.pointerLockElement !== canvas || now < nextClientShotAt) return;
  nextClientShotAt = now + 50;
  network.shoot();
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

  const delta = Math.min((now - (window.lastFrameTime || now)) / 1000, 0.1);
  window.lastFrameTime = now;

  // Update asset manager animations
  if (assetsLoaded) {
    assetManager.update(delta);
  }

  // Update lobby scene if active
  if (lobbyScene && !matchActive) {
    lobbyScene.update(delta);
  }

  if (matchActive) {
    if (canPlay() && network.connected) {
      const input = controller.getInput(inputSequence++);
      if (!latestPlayerAlive) {
        input.forward = 0;
        input.strafe = 0;
        input.jump = false;
      }
      network.sendInput(input);
      if (trigger.shouldRepeat) fireOnce(now);
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
