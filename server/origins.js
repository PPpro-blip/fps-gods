// CLIENT_ORIGIN decides which browser origins may open a Socket.IO connection.
// The value is a comma-separated list of exact origins that may contain `*`
// wildcards, which matters for hosts that mint a unique URL per deployment
// (for example Vercel previews such as https://fps-gods-git-fix-me.vercel.app).
//
// An empty/unset list keeps the permissive development behaviour so `npm run dev`
// works without an env file. CORS only constrains browsers: it is not an
// authentication mechanism, so gameplay is still validated server-side.

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalise(origin) {
  return origin.trim().replace(/\/+$/, '');
}

function compilePattern(pattern) {
  if (!pattern.includes('*')) {
    const expected = pattern.toLowerCase();
    return (origin) => origin.toLowerCase() === expected;
  }

  const source = pattern.split('*').map(escapeRegExp).join('.*');
  const expression = new RegExp(`^${source}$`, 'i');
  return (origin) => expression.test(origin);
}

/**
 * Parse the raw CLIENT_ORIGIN value into a list of compiled matchers.
 * @param {string} [value]
 * @returns {Array<{ pattern: string, matches: (origin: string) => boolean }>}
 */
export function parseAllowedOrigins(value = '') {
  return value
    .split(',')
    .map(normalise)
    .filter(Boolean)
    .map((pattern) => ({ pattern, matches: compilePattern(pattern) }));
}

/**
 * Build the Socket.IO/CORS `origin` option from CLIENT_ORIGIN.
 * Returns `true` when nothing is configured (accept every origin) and otherwise
 * a `(origin, callback)` predicate the `cors` package understands.
 * @param {string} [value]
 */
export function createCorsOrigin(value = '') {
  const allowed = parseAllowedOrigins(value);
  if (!allowed.length) return true;

  return function corsOrigin(origin, callback) {
    const candidate = normalise(origin ?? '');
    callback(null, Boolean(candidate) && allowed.some((entry) => entry.matches(candidate)));
  };
}

/** Report whether a specific origin would be accepted. Handy for tests/CLI. */
export function isOriginAllowed(value, origin) {
  const configured = createCorsOrigin(value);
  if (configured === true) return true;

  let accepted = false;
  configured(origin, (_error, allowedOrigin) => {
    accepted = Boolean(allowedOrigin);
  });
  return accepted;
}
