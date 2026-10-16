import assert from 'node:assert/strict';
import test from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { EVENTS, ROOM_STATES } from '../shared/events.js';
import { createGameServer } from '../server/index.js';

// Deployment-facing checks for the Express/Socket.IO game server: the health
// route used by host health checks, the CORS policy driven by CLIENT_ORIGIN for
// the Vercel-hosted client, and a real Socket.IO handshake that creates a room.
const PRODUCTION_ORIGIN = 'https://fps-gods.vercel.app';
const PREVIEW_ORIGIN = 'https://fps-gods-6xb0b1zm3-pppro-blips-projects.vercel.app';
const CLIENT_ORIGIN = `${PRODUCTION_ORIGIN},https://fps-gods-*.vercel.app`;

async function startServer() {
  const server = createGameServer({ clientOrigin: CLIENT_ORIGIN });
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

test('socket.io handshakes are allowed for the deployed client origins', async () => {
  const server = await startServer();
  try {
    const production = await handshake(server.url, '/socket.io/?EIO=4&transport=polling', PRODUCTION_ORIGIN);
    assert.equal(production.status, 200);
    assert.equal(production.allowOrigin, PRODUCTION_ORIGIN);
    assert.match(production.body, /"sid":"/);
    assert.match(production.body, /"upgrades":\["websocket"\]/);

    // Per-deployment Vercel preview hosts match the wildcard entry.
    const preview = await handshake(server.url, '/socket.io/?EIO=4&transport=polling', PREVIEW_ORIGIN);
    assert.equal(preview.allowOrigin, PREVIEW_ORIGIN);
  } finally {
    await server.close();
  }
});

test('socket.io handshakes omit CORS headers for origins outside CLIENT_ORIGIN', async () => {
  const server = await startServer();
  try {
    const blocked = await handshake(server.url, '/socket.io/?EIO=4&transport=polling', 'https://evil.example');
    assert.equal(blocked.status, 200);
    assert.equal(blocked.allowOrigin, null, 'a rejected origin must not receive Access-Control-Allow-Origin');
  } finally {
    await server.close();
  }
});

test('a browser client from the deployed origin connects and creates a room', async () => {
  const server = await startServer();
  const socket = ioClient(server.url, {
    // Polling is the transport that carries Origin in Node, which is what the
    // server's CORS policy inspects; browsers upgrade to websockets afterwards.
    transports: ['polling'],
    extraHeaders: { Origin: PRODUCTION_ORIGIN },
    reconnection: false,
    timeout: 5_000,
  });

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('socket.io did not connect within 5s')), 5_000).unref();
    });

    assert.ok(socket.id, 'the server should assign a socket id');

    const roomState = await new Promise((resolve, reject) => {
      socket.once(EVENTS.ROOM_STATE, resolve);
      socket.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      socket.emit(EVENTS.CREATE_ROOM, { name: 'DeployCheck' });
      setTimeout(() => reject(new Error('no ROOM_STATE within 5s')), 5_000).unref();
    });

    assert.match(roomState.code, /^[A-Z2-9]{6}$/);
    assert.equal(roomState.state, ROOM_STATES.LOBBY);
    assert.equal(roomState.players.length, 1);
    assert.equal(roomState.players[0].name, 'DeployCheck');
    assert.equal(server.roomManager.rooms.size, 1);
  } finally {
    socket.close();
    await server.close();
  }
});

test('an unrestricted CLIENT_ORIGIN still accepts connections (local development)', async () => {
  const server = createGameServer({ clientOrigin: '' });
  const port = await new Promise((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => resolve(server.httpServer.address().port));
  });

  try {
    const result = await handshake(`http://127.0.0.1:${port}`, '/socket.io/?EIO=4&transport=polling', 'http://localhost:5173');
    assert.equal(result.status, 200);
    assert.equal(result.allowOrigin, 'http://localhost:5173');
  } finally {
    await server.close();
  }
});
