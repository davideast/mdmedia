import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const localEnv = new URL('../.env.local', import.meta.url);
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
const base = process.argv[2] || `http://127.0.0.1:${process.env.PORT || '3000'}`;
const expectedOrigin = process.argv[3] || process.env.MDMEDIA_PUBLIC_ORIGIN || new URL(base).origin;
// A preview can exercise public link generation without publishing the candidate.
const forwarded = process.argv[3] ? {
  host: new URL(expectedOrigin).host,
  'x-forwarded-host': new URL(expectedOrigin).host,
  'x-forwarded-proto': new URL(expectedOrigin).protocol.replace(':', ''),
} : {};
const request = (path, options = {}) => fetch(new URL(path, base), {
  ...options,
  headers: { ...forwarded, ...options.headers },
  signal: AbortSignal.timeout(10_000),
});

assert.equal((await request('/api/connectivity')).status, 200);
for (const [method, path, body] of [
  ['GET', '/api/v1/options'],
  ['GET', '/api/v1/keys'],
  ['GET', '/api/v1/narrations/abcdefghij'],
  ['GET', '/api/v1/narrations/abcdefghij/audio'],
  ['POST', '/api/v1/narrations', { markdown: 'Unauthorized smoke check; must not synthesize.' }],
]) {
  const response = await request(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 401, `${method} ${path}`);
  assert.equal((await response.json()).error.code, 'unauthenticated');
}
assert.equal((await request('/connect')).status, 200);
const start = await request('/api/v1/device', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientName: 'Deployment smoke check (unapproved)' }),
});
assert.equal(start.status, 200);
const device = await start.json();
assert.equal(typeof device.deviceCode, 'string');
const poll = await request('/api/v1/device/token', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceCode: device.deviceCode }),
});
assert.equal(poll.status, 200);
assert.equal((await poll.json()).status, 'pending');
assert.equal(device.verificationUri, `${expectedOrigin}/connect`, 'Approval URL must use the public Studio origin');
assert.equal(new URL(device.verificationUriComplete).origin, expectedOrigin);
assert.equal(new URL(device.verificationUriComplete).searchParams.get('code'), device.userCode);
console.log(`${base}: API authentication, approval page, device start/pending poll, and public approval links pass. No access granted.`);
