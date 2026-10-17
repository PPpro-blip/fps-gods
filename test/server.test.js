import assert from 'node:assert/strict';
import test from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { EVENTS, ROOM_STATES, ROOM_TYPES } from '../shared/events.js';
import { BOTS } from '../shared/gameConfig.js';
import { createGameServer } from '../server/index.js';

// Deployment-facing checks for the Express/Socket.IO game server: the health
// route used by host health checks, the wildcard CORS handshake that keeps
// every Vercel deployment connected, and real Socket.IO flows for multiplayer
// rooms plus the PLAY NOW solo bot mode.
const PRODUCTION_ORIGIN = 'https://fps-gods.vercel.app';
const PREVIEW_ORIGIN = 'https://fps-gods-6xb0b1zm3-pppro-blips-projects.vercel.app';

async function startServer() {
  const server = createGameServer();
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

function connectSocket(url, origin = PRODUCTION_ORIGIN) {
  const socket = ioClient(url, {
    // Polling is the transport that carries Origin in Node, which is what the
    // server's CORS policy inspects; browsers upgrade to websockets afterwards.
    transports: ['polling'],
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 5_000,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket.io did not connect within 5s')), 5_000).unref();
  });
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

test('socket.io handshakes answer Access-Control-Allow-Origin: * for any origin', async () => {
  const server = await startServer();
  try {
    for (const origin of [PRODUCTION_ORIGIN, PREVIEW_ORIGIN, 'https://evil.example', 'http://localhost:5173']) {
      const result = await handshake(server.url, '/socket.io/?EIO=4&transport=polling', origin);
      assert.equal(result.status, 200);
      assert.equal(result.allowOrigin, '*', `${origin} must receive the wildcard header`);
      assert.match(result.body, /"sid":"/);
      assert.match(result.body, /"upgrades":\["websocket"\]/);
    }
  } finally {
    await server.close();
  }
});

test('a browser client from the deployed origin connects and creates a room', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url);

  try {
    assert.ok(socket.id, 'the server should assign a socket id');

    const roomState = await new Promise((resolve, reject) => {
      socket.once(EVENTS.ROOM_STATE, resolve);
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.CREATE_ROOM, { name: 'DeployCheck', bundle: 'ghost', lifetimeKills: 3 });
      setTimeout(() => reject(new Error('no ROOM_STATE within 5s')), 5_000).unref();
    });

    assert.match(roomState.code, /^[A-Z2-9]{6}$/);
    assert.equal(roomState.state, ROOM_STATES.LOBBY);
    assert.equal(roomState.type, ROOM_TYPES.MULTIPLAYER);
    assert.equal(roomState.players.length, 1);
    assert.equal(roomState.players[0].name, 'DeployCheck');
    assert.equal(roomState.players[0].bundleId, 'ghost');
    assert.equal(server.roomManager.rooms.size, 1);
  } finally {
    socket.close();
    await server.close();
  }
});

test('PLAY NOW drops a player into a live SOLO_VS_BOTS match with five GOD BOTS', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url);

  try {
    const started = new Promise((resolve, reject) => {
      socket.once(EVENTS.GAME_START, resolve);
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.PLAY_SOLO, { name: 'LoneWolf', bundle: 'rusher', lifetimeKills: 0 });
      setTimeout(() => reject(new Error('no GAME_START within 5s')), 5_000).unref();
    });
    const gameStart = await started;
    assert.equal(gameStart.type, ROOM_TYPES.SOLO_VS_BOTS);
    assert.equal(gameStart.playerCount, 1 + BOTS.count);

    const soloRoom = [...server.roomManager.rooms.values()].find((room) => room.type === ROOM_TYPES.SOLO_VS_BOTS);
    assert.ok(soloRoom, 'a solo room exists');
    assert.equal(soloRoom.state, ROOM_STATES.PLAYING);
    const bots = [...soloRoom.players.values()].filter((player) => player.isBot);
    assert.equal(bots.length, 5);
    assert.deepEqual(bots.map((bot) => bot.name), [
      'GOD_BOT_01', 'GOD_BOT_02', 'GOD_BOT_03', 'GOD_BOT_04', 'GOD_BOT_05',
    ]);

    // A live snapshot arrives at 20 Hz and lists humans and bots alike.
    const snapshot = await new Promise((resolve, reject) => {
      socket.once(EVENTS.GAME_STATE_UPDATE, resolve);
      setTimeout(() => reject(new Error('no GAME_STATE_UPDATE within 5s')), 5_000).unref();
    });
    assert.equal(snapshot.players.length, 1 + BOTS.count);
    assert.equal(snapshot.players.filter((player) => player.isBot).length, 5);
    assert.equal(snapshot.players.find((player) => player.id === socket.id).weaponId, 'smg');
  } finally {
    socket.close();
    await server.close();
  }
});

test('weapon switches reach the server and AMMO_UPDATE reflects the new gun', async () => {
  const server = await startServer();
  const socket = await connectSocket(server.url);

  try {
    await new Promise((resolve, reject) => {
      socket.once(EVENTS.GAME_START, resolve);
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.PLAY_SOLO, { name: 'Switcher', bundle: 'rusher', lifetimeKills: 0 });
      setTimeout(() => reject(new Error('no GAME_START within 5s')), 5_000).unref();
    });

    const ammoUpdate = new Promise((resolve) => {
      socket.on(EVENTS.AMMO_UPDATE, (data) => {
        if (data.weaponId === 'shotgun') resolve(data);
      });
    });
    socket.emit(EVENTS.SWITCH_WEAPON, { slot: 1 });

    const data = await Promise.race([
      ammoUpdate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no AMMO_UPDATE for the switched weapon')), 5_000)),
    ]);
    assert.equal(data.slot, 1);
    assert.equal(data.weaponId, 'shotgun');
    assert.equal(data.maxAmmo, 6);
  } finally {
    socket.close();
    await server.close();
  }
});

test('an unrestricted CLIENT_ORIGIN env var no longer blocks anyone (wildcard policy)', async () => {
  process.env.CLIENT_ORIGIN = 'https://only-this.example';
  try {
    const server = createGameServer();
    const port = await new Promise((resolve) => {
      server.httpServer.listen(0, '127.0.0.1', () => resolve(server.httpServer.address().port));
    });

    try {
      const result = await handshake(`http://127.0.0.1:${port}`, '/socket.io/?EIO=4&transport=polling', 'http://localhost:5173');
      assert.equal(result.status, 200);
      assert.equal(result.allowOrigin, '*');
    } finally {
      await server.close();
    }
  } finally {
    delete process.env.CLIENT_ORIGIN;
  }
});
