import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_ORIGIN, createCorsOrigin, isOriginAllowed, socketCorsOptions } from '../server/origins.js';

// The server answers every browser origin with `*` so the deployed client on
// fps-gods.vercel.app (and any preview URL) never dies on a CORS allowlist.
test('the socket CORS policy is a wildcard for methods browsers use', () => {
  const options = socketCorsOptions();
  assert.equal(options.credentials, true);
  options.origin('https://fps-gods.vercel.app', (_err, result) => assert.equal(result, 'https://fps-gods.vercel.app'));
  options.origin('https://evil.example', (_err, result) => assert.equal(result, false));
  assert.equal(ALLOWED_ORIGIN, '*');
  assert.deepEqual(options.methods, ['GET', 'POST']);
});

test('every origin is allowed, whatever CLIENT_ORIGIN once said', () => {
  assert.equal(createCorsOrigin('https://only-this.example'), '*');
  assert.equal(createCorsOrigin(''), '*');
  assert.equal(isOriginAllowed('https://only-this.example', 'https://evil.example'), true);
  assert.equal(isOriginAllowed('', 'http://localhost:5173'), true);
});
