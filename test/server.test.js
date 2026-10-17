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

test('the health route reports ok for host health checks', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'fps-gods-game-server',
      rooms: 0,
    });
  } finally {
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
