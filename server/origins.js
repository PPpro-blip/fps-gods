// Credentialed browser sessions use an exact allowlist. Legacy helpers below
// retain the old anonymous-origin compatibility API; they are not used for auth.

/** Legacy anonymous wildcard constant; not used for credentialed CORS. */
export const ALLOWED_ORIGIN = '*';

/** Socket.IO `cors` option used by server/index.js. */
export function socketCorsOptions() {
  return {
    origin(origin, callback) { callback(null, isCredentialOriginAllowed(origin) ? origin : false); },
    credentials: true,
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

// Credentialed browser requests must use an explicit, trusted origin. Additional
// deployments can be configured as a comma-separated list of exact origins.
export function isCredentialOriginAllowed(origin, configured = process.env.CLIENT_ORIGIN || '') {
  const allowed = new Set([
    'https://fps-gods.vercel.app',
    'https://fps-gods-production.up.railway.app',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...configured.split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  return allowed.has(origin);
}
