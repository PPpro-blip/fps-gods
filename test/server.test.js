import assert from 'node:assert/strict';
import test from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { createMemoryProfileStore } from '../server/profiles.js';
import { createGameServer } from '../server/index.js';

async function startServer() {
  const server = createGameServer({ profileStore: createMemoryProfileStore() });
  const port = await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => resolve(server.httpServer.address().port));
  });
  return { ...server, port, url: `http://127.0.0.1:${port}` };
}

async function handshake(url, path, origin) {
  const response = await fetch(`${url}${path}`, {
    headers: origin ? { Origin: origin } : {},
  });
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
    body: await response.text(),
  };
}

async function connectSocket(url, origin) {
  const socket = ioClient(url, {
    transports: ['polling'],
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 5_000,
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket.io did not connect within 5s')), 5_000).unref();
  });
  return socket;
}

function waitForEvent(socket, event, predicate = () => true, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let lastData = null;
    const timeout = setTimeout(() => {
      socket.off(event, onData);
      reject(new Error(`no ${event} event within ${timeoutMs}ms; last event was ${JSON.stringify(lastData)?.slice(0, 240) ?? 'none'}`));
    }, timeoutMs);
    const onData = (data) => {
      lastData = data;
      if (!predicate(data)) return;
      clearTimeout(timeout);
      socket.off(event, onData);
      resolve(data);
    };
    socket.on(event, onData);
  });
}

test('the health route reports ok for host health checks', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'fps-gods-game-server');
    // Uptime is what tells an operator the instance is awake rather than cold.
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.uptime >= 0);
    assert.equal(body.rooms, 0);
    assert.equal(body.connections, 0);
    assert.equal(typeof body.now, 'number');
  } finally {
    await server.close();
  }
});

test('the health endpoint is readable by the browser connection probe', async () => {
  const server = await startServer();
  try {
    // The client fetches /health from the deployed page's origin to decide
    // between SERVER OFFLINE and CONNECTION LOST; a blocked read looks like an outage.
    const response = await fetch(`${server.url}/health`, {
      headers: { Origin: 'https://fps-gods.vercel.app' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test('the health endpoint counts live rooms and connections', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url, 'https://fps-gods.vercel.app');
  try {
    const before = await (await fetch(`${server.url}/health`)).json();
    assert.equal(before.rooms, 0);
    assert.equal(before.connections, 1);

    const roomState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no ROOM_STATE within 5s')), 5_000);
      socket.once(EVENTS.ROOM_STATE, (state) => { clearTimeout(timeout); resolve(state); });
      socket.once(EVENTS.ROOM_ERROR, (error) => { clearTimeout(timeout); reject(new Error(error.message)); });
      socket.emit(EVENTS.CREATE_ROOM, { name: 'HealthCount', bundleId: 'RUSHER' });
    });
    assert.match(roomState.code, /^[A-Z2-9]{6}$/);

    const after = await (await fetch(`${server.url}/health`)).json();
    assert.equal(after.rooms, 1, 'a created room must show up in the health payload');
    assert.equal(after.status, 'ok');
    assert.ok(after.uptime >= 0 && Number.isFinite(after.uptime));
  } finally {
    socket.close();
    await server.close();
  }
});

test('Socket.IO CORS accepts every origin with a wildcard response', async () => {
  const server = await startServer();
  try {
    for (const origin of [
      'https://fps-gods.vercel.app',
      'https://fps-gods-6xb0b1zm3-pppro-blips-projects.vercel.app',
      'https://any-origin.example',
    ]) {
      const result = await handshake(server.url, '/socket.io/?EIO=4&transport=polling', origin);
      assert.equal(result.status, 200);
      assert.equal(result.allowOrigin, '*');
      assert.match(result.body, /"sid":"/);
      assert.match(result.body, /"upgrades":\["websocket"\]/);
    }
  } finally {
    await server.close();
  }
});

test('a connected client creates an isolated multiplayer lobby', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url, 'https://any-origin.example');

  try {
    const roomState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no ROOM_STATE within 5s')), 5_000);
      socket.once(EVENTS.ROOM_STATE, (state) => {
        clearTimeout(timeout);
        resolve(state);
      });
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.CREATE_ROOM, { name: 'DeployCheck' });
    });

    assert.match(roomState.code, /^[A-Z2-9]{6}$/);
    assert.equal(roomState.state, ROOM_STATES.LOBBY);
    assert.equal(roomState.mode, ROOM_MODES.MULTIPLAYER);
    assert.equal(roomState.players.length, 1);
    assert.equal(roomState.players[0].name, 'DeployCheck');
    assert.equal(server.roomManager.rooms.size, 1);
  } finally {
    socket.close();
    await server.close();
  }
});

test('PLAY_NOW instantly starts SOLO_VS_BOTS with five named bots', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url, 'https://any-origin.example');

  try {
    const roomState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no playing ROOM_STATE within 5s')), 5_000);
      socket.on(EVENTS.ROOM_STATE, (state) => {
        if (state.state !== ROOM_STATES.PLAYING) return;
        clearTimeout(timeout);
        resolve(state);
      });
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.PLAY_NOW, { name: 'SoloRanger' });
    });

    assert.match(roomState.code, /^[A-Z2-9]{6}$/);
    assert.equal(roomState.state, ROOM_STATES.PLAYING);
    assert.equal(roomState.mode, ROOM_MODES.SOLO_VS_BOTS);
    assert.equal(roomState.players.length, 6);
    assert.equal(roomState.players.find((player) => player.name === 'SoloRanger')?.isBot, false);
    assert.deepEqual(
      roomState.players.filter((player) => player.isBot).map((player) => player.name).sort(),
      ['GOD_BOT_01', 'GOD_BOT_02', 'GOD_BOT_03', 'GOD_BOT_04', 'GOD_BOT_05'],
    );

    const room = server.roomManager.rooms.get(roomState.code);
    assert.equal(room?.game?.players.size, 6);
    assert.equal(room?.game?.mode, ROOM_MODES.SOLO_VS_BOTS);
  } finally {
    socket.close();
    await server.close();
  }
});

test('PLAY_AGAIN redeploys a finished solo match with fresh bots and score', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url, 'https://any-origin.example');

  try {
    const playingState = waitForEvent(
      socket,
      EVENTS.ROOM_STATE,
      (state) => state.state === ROOM_STATES.PLAYING && state.mode === ROOM_MODES.SOLO_VS_BOTS,
    );
    socket.emit(EVENTS.PLAY_NOW, { name: 'SoloRanger' });
    const firstState = await playingState;

    const room = server.roomManager.rooms.get(firstState.code);
    const firstGame = room.game;
    assert.equal(firstGame.players.size, 6);

    const endPromise = waitForEvent(socket, EVENTS.GAME_END, (data) => data.code === firstState.code);
    server.roomManager.endGame(room, { id: socket.id, name: 'SoloRanger', kills: 30 });
    const end = await endPromise;
    assert.equal(end.mode, ROOM_MODES.SOLO_VS_BOTS, 'the end screen can tell solo from multiplayer');
    assert.equal(room.state, ROOM_STATES.ENDED);

    const startPromise = waitForEvent(socket, EVENTS.GAME_START, (data) => data.code === firstState.code);
    const replayStatePromise = waitForEvent(
      socket,
      EVENTS.ROOM_STATE,
      (state) => state.code === firstState.code && state.state === ROOM_STATES.PLAYING,
    );
    socket.emit(EVENTS.PLAY_AGAIN);
    const [startData, replayState] = await Promise.all([startPromise, replayStatePromise]);

    assert.equal(startData.mode, ROOM_MODES.SOLO_VS_BOTS);
    assert.equal(room.state, ROOM_STATES.PLAYING);
    assert.equal(room.winner, null);
    assert.notEqual(room.game, firstGame, 'a replay gets a brand-new authoritative simulation');
    assert.equal(room.game.players.size, 6);
    assert.equal(replayState.players.length, 6);
    assert.equal(room.game.getScoreboard().every((player) => player.kills === 0), true);
  } finally {
    socket.close();
    await server.close();
  }
});

test('two live clients join, ready, play, synchronize weapon switches, and resume a room session', async () => {
  const server = await startServer();
  const host = await connectSocket(server.url, 'https://host.example');
  const guest = await connectSocket(server.url, 'https://guest.example');
  const guestId = guest.id;
  let resumedGuest;
  let phase = 'create room';
  const guestProfileId = 'multiplayer-guest-profile';

  try {
    const hostSessionPromise = waitForEvent(host, EVENTS.ROOM_SESSION);
    const hostRoomPromise = waitForEvent(host, EVENTS.ROOM_STATE, (state) => state.players.length === 1);
    host.emit(EVENTS.CREATE_ROOM, {
      name: 'LiveHost',
      profileId: 'multiplayer-host-profile',
      bundleId: 'RUSHER',
    });
    const [hostSession, lobby] = await Promise.all([hostSessionPromise, hostRoomPromise]);
    assert.equal(lobby.mode, ROOM_MODES.MULTIPLAYER);
    assert.equal(lobby.players[0].name, 'LiveHost');

    phase = 'join room';
    const guestSessionPromise = waitForEvent(guest, EVENTS.ROOM_SESSION);
    const joinedRoomPromise = waitForEvent(guest, EVENTS.ROOM_STATE, (state) => state.players.length === 2);
    guest.emit(EVENTS.JOIN_ROOM, {
      code: lobby.code,
      name: 'LiveGuest',
      profileId: guestProfileId,
      bundleId: 'GHOST',
    });
    const [guestSession, joinedRoom] = await Promise.all([guestSessionPromise, joinedRoomPromise]);
    assert.deepEqual(joinedRoom.players.map((player) => player.bundleId).sort(), ['GHOST', 'RUSHER']);
    assert.equal(hostSession.roomCode, lobby.code);
    assert.equal(guestSession.roomCode, lobby.code);

    phase = 'ready both players';
    const readyRoomPromise = waitForEvent(host, EVENTS.ROOM_STATE, (state) => state.players.length === 2 && state.players.every((player) => player.ready));
    host.emit(EVENTS.PLAYER_READY, { ready: true });
    guest.emit(EVENTS.PLAYER_READY, { ready: true });
    await readyRoomPromise;

    phase = 'start the match';
    const liveRoomPromise = waitForEvent(host, EVENTS.ROOM_STATE, (state) => state.state === ROOM_STATES.PLAYING);
    host.emit(EVENTS.START_GAME);
    const liveRoom = await liveRoomPromise;
    const room = server.roomManager.rooms.get(lobby.code);
    const originalGuestState = room.game.players.get(guest.id);
    assert.ok(originalGuestState);

    phase = 'synchronize weapon switch';
    const synchronizedSwitch = waitForEvent(
      host,
      EVENTS.WEAPON_UPDATE,
      (data) => data.playerId === guest.id && data.weaponId === 'SNIPER',
    );
    guest.emit(EVENTS.WEAPON_SWITCH, { weaponId: 'SNIPER' });
    const switchData = await synchronizedSwitch;
    assert.equal(switchData.bundleId, 'GHOST');

    phase = 'broadcast accepted shots to the room';
    const synchronizedShot = waitForEvent(host, EVENTS.WEAPON_FIRED, (data) => data.playerId === guest.id);
    guest.emit(EVENTS.SHOOT);
    const shotData = await synchronizedShot;
    assert.equal(shotData.weaponId, 'SNIPER');
    assert.equal(shotData.bundleId, 'GHOST');
    assert.ok(Number.isFinite(shotData.origin.x) && Number.isFinite(shotData.direction.z));

    const guestPosition = room.game.players.get(guest.id);
    const initialX = guestPosition.x;
    const initialZ = guestPosition.z;
    const yawTowardCenter = Math.atan2(initialX, initialZ);
    phase = 'server movement';
    const movedStatePromise = waitForEvent(host, EVENTS.GAME_STATE_UPDATE, (state) => {
      const player = state.players.find((entry) => entry.id === guest.id);
      return player && Math.hypot(player.x - initialX, player.z - initialZ) > 0.12;
    });
    guest.emit(EVENTS.PLAYER_INPUT, {
      seq: 1,
      forward: 1,
      strafe: 0,
      jump: false,
      yaw: yawTowardCenter,
      pitch: 0,
    });
    const movedState = await movedStatePromise;
    assert.equal(movedState.players.find((player) => player.id === guest.id).currentWeaponId, 'SNIPER');
    assert.equal(liveRoom.state, ROOM_STATES.PLAYING);

    phase = 'mark disconnected player';
    const offlineRoomPromise = waitForEvent(host, EVENTS.ROOM_STATE, (state) => state.players.some((player) => player.id === guestId && player.connected === false));
    guest.disconnect();
    await offlineRoomPromise;
    const positionBeforeResume = { x: guestPosition.x, z: guestPosition.z, kills: guestPosition.kills };

    phase = 'resume disconnected player';
    resumedGuest = await connectSocket(server.url, 'https://guest.example');
    const resumedRoomPromise = waitForEvent(resumedGuest, EVENTS.ROOM_STATE, (state) => state.state === ROOM_STATES.PLAYING
      && state.players.some((player) => player.id === resumedGuest.id && player.connected === true));
    const rotatedSessionPromise = waitForEvent(resumedGuest, EVENTS.ROOM_SESSION);
    resumedGuest.emit(EVENTS.PROFILE_REQUEST, { profileId: guestProfileId, callsign: 'LiveGuest' });
    resumedGuest.emit(EVENTS.ROOM_RESUME, guestSession);
    const [resumedRoom, rotatedSession] = await Promise.all([resumedRoomPromise, rotatedSessionPromise]);
    const resumedPlayer = resumedRoom.players.find((player) => player.id === resumedGuest.id);
    const resumedGamePlayer = room.game.players.get(resumedGuest.id);
    assert.equal(resumedPlayer.currentWeaponId, 'SNIPER');
    assert.ok(resumedGamePlayer);
    assert.equal(resumedGamePlayer.kills, positionBeforeResume.kills);
    assert.equal(rotatedSession.roomCode, lobby.code);
    assert.notEqual(rotatedSession.resumeToken, guestSession.resumeToken);
    assert.ok(Math.hypot(resumedGamePlayer.x - positionBeforeResume.x, resumedGamePlayer.z - positionBeforeResume.z) < 0.1);

    phase = 'leave room';
    const hostRoomAfterLeave = waitForEvent(host, EVENTS.ROOM_STATE, (state) => state.players.length === 1);
    const leftRoom = waitForEvent(resumedGuest, EVENTS.ROOM_LEFT);
    resumedGuest.emit(EVENTS.LEAVE_ROOM);
    await Promise.all([hostRoomAfterLeave, leftRoom]);
    assert.equal(server.roomManager.rooms.get(lobby.code).players.has(resumedGuest.id), false);
  } catch (error) {
    error.message = `${phase}: ${error.message}`;
    throw error;
  } finally {
    host.disconnect();
    guest.disconnect();
    resumedGuest?.disconnect();
    await server.close();
  }
});

test('server profile requests persist the player key and enforce bundle unlocks before room entry', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url, 'https://any-origin.example');

  try {
    const profile = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no PROFILE_UPDATE within 5s')), 5_000);
      socket.once(EVENTS.PROFILE_UPDATE, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
      socket.emit(EVENTS.PROFILE_REQUEST, { profileId: 'profile-integration', callsign: 'BundleTester' });
    });
    assert.equal(profile.profileId, 'profile-integration');
    assert.equal(profile.lifetimeKills, 0);
    assert.equal(profile.godsTierUnlocked, false);

    const lockedError = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no locked-bundle ROOM_ERROR within 5s')), 5_000);
      socket.once(EVENTS.ROOM_ERROR, (error) => {
        clearTimeout(timeout);
        resolve(error);
      });
      socket.emit(EVENTS.CREATE_ROOM, {
        name: 'BundleTester',
        profileId: profile.profileId,
        bundleId: 'GODS_TIER',
      });
    });
    assert.match(lockedError.message, /30 lifetime kills/i);
    assert.equal(server.roomManager.rooms.size, 0);

    for (let kill = 0; kill < 30; kill += 1) {
      server.roomManager.profileStore.recordLifetimeKill(profile.profileId);
    }
    const roomState = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no unlocked ROOM_STATE within 5s')), 5_000);
      socket.once(EVENTS.ROOM_STATE, (state) => {
        clearTimeout(timeout);
        resolve(state);
      });
      socket.emit(EVENTS.CREATE_ROOM, {
        name: 'BundleTester',
        profileId: profile.profileId,
        bundleId: 'GODS_TIER',
      });
    });
    assert.equal(roomState.players[0].bundleId, 'GODS_TIER');
    assert.equal(roomState.players[0].currentWeaponId, 'RAILGUN');
  } finally {
    socket.close();
    await server.close();
  }
});
