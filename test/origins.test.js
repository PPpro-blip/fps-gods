import assert from 'node:assert/strict';
import test from 'node:test';
import { createCorsOrigin, isOriginAllowed, parseAllowedOrigins } from '../server/origins.js';

const PRODUCTION = 'https://fps-gods.vercel.app';
const WILDCARD = 'https://fps-gods-*.vercel.app';
const PREVIEW = 'https://fps-gods-6xb0b1zm3-pppro-blips-projects.vercel.app';
const LIST = `${PRODUCTION},${WILDCARD}`;

test('an empty CLIENT_ORIGIN keeps permissive development behaviour', () => {
  assert.equal(createCorsOrigin(''), true);
  assert.equal(createCorsOrigin(undefined), true);
  assert.equal(isOriginAllowed('', 'https://anything.example'), true);
  assert.deepEqual(parseAllowedOrigins('  ,  ,'), []);
});

test('exact origins are matched case-insensitively and ignore trailing slashes', () => {
  assert.equal(isOriginAllowed('https://FPS-Gods.Vercel.app/', PRODUCTION), true);
  assert.equal(isOriginAllowed(LIST, 'https://fps-gods.vercel.app/'), true);
  assert.equal(isOriginAllowed(LIST, 'http://fps-gods.vercel.app'), false);
});

test('wildcard patterns cover per-deployment preview hosts', () => {
  assert.equal(isOriginAllowed(LIST, PREVIEW), true);
  assert.equal(isOriginAllowed(WILDCARD, 'https://fps-gods-git-fix-deploy-me.vercel.app'), true);
  assert.equal(isOriginAllowed(WILDCARD, 'https://fps-gods.evil.example'), false);
});

test('wildcards are literal, not regular expressions', () => {
  // A "." in the pattern must not match arbitrary characters.
  assert.equal(isOriginAllowed('https://fps-gods.vercel.app', 'https://fps-godsXvercelYapp'), false);
  // "*" must not swallow the scheme or the host boundary.
  assert.equal(isOriginAllowed(WILDCARD, 'https://evil.com/?x=fps-gods-a.vercel.app'), false);
  assert.equal(isOriginAllowed(WILDCARD, 'http://fps-gods-a.vercel.app'), false);
});

test('unlisted and missing origins are rejected', () => {
  assert.equal(isOriginAllowed(LIST, 'https://evil.example'), false);
  assert.equal(isOriginAllowed(LIST, ''), false);
  assert.equal(isOriginAllowed(LIST, 'null'), false);
});

test('the cors predicate reports its decision through the callback', () => {
  const corsOrigin = createCorsOrigin(LIST);
  assert.equal(typeof corsOrigin, 'function');

  const decisions = new Map();
  for (const origin of [PRODUCTION, PREVIEW, 'https://evil.example']) {
    corsOrigin(origin, (error, allowed) => {
      assert.equal(error, null);
      decisions.set(origin, allowed);
    });
  }

  assert.equal(decisions.get(PRODUCTION), true);
  assert.equal(decisions.get(PREVIEW), true);
  assert.equal(decisions.get('https://evil.example'), false);
});

test('parseAllowedOrigins keeps patterns in declaration order without blanks', () => {
  assert.deepEqual(parseAllowedOrigins(' a , ,b/ ,').map((entry) => entry.pattern), ['a', 'b']);
});
