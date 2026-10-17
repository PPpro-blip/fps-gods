// Socket.IO browser-origin policy for the game server.
//
// The arena is meant to be played from any deployment (localhost, Vercel
// production, per-branch previews) against one persistent Node host, so the
// handshake answers `Access-Control-Allow-Origin: *` for every origin. CORS is
// a browser policy, not authentication: gameplay is still validated entirely
// server-side, and a wildcard simply removes the "CONNECTION LOST" failure mode
// caused by origin allowlists drifting out of sync with deployment URLs.

/** The one Socket.IO/CORS origin answer this server ever gives. */
export const ALLOWED_ORIGIN = '*';

/** Socket.IO `cors` option used by server/index.js. */
export function socketCorsOptions() {
  return {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  };
}

/**
 * Compatibility shim for older call sites/tests: always the wildcard policy.
 * @returns {'*'}
 */
export function createCorsOrigin(_value = '') {
  return ALLOWED_ORIGIN;
}

/** Report whether a specific origin would be accepted — always true. */
export function isOriginAllowed(_value, _origin) {
  return true;
}
