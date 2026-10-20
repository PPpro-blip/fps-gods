// Single source of truth for the port the game server binds to when the host has
// not assigned one, and for the URL the Vite dev proxy forwards to.
//
// These two values MUST agree, or `npm run dev` connects the client to a port
// with nothing listening on it: the server binds the fallback here while Vite
// proxies to its own default, and a one-sided edit produces the exact
// "CONNECTION LOST" symptom this project already has a ticket about. Keeping one
// constant that both entrypoints import is what prevents that drift, so please
// do not re-inline a numeric port in server/index.js or vite.config.js.
//
// This is a LOCAL default only. PaaS hosts (Railway, Render) inject PORT at
// runtime - Railway's is commonly 8080, not 3000 - and the app must bind to the
// injected value, which `Number(process.env.PORT) || DEFAULT_GAME_SERVER_PORT`
// already does. Never hardcode a port for a hosted deploy.

/** Default listen port for the Express + Socket.IO game server. */
export const DEFAULT_GAME_SERVER_PORT = 3000;

/** Default listen host. `0.0.0.0` is required by containerized hosts. */
export const DEFAULT_GAME_SERVER_HOST = '0.0.0.0';

/** Loopback URL the Vite dev proxy forwards `/socket.io` to. */
export const DEFAULT_DEV_PROXY_TARGET = `http://127.0.0.1:${DEFAULT_GAME_SERVER_PORT}`;
