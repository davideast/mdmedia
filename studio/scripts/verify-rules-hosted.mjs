#!/usr/bin/env node

/**
 * Mock-aware Rules Test API harness using the Firebase CLI login.
 *
 * Calls only `firebaserules.googleapis.com/v1/projects/${PROJECT}:test` (read-only).
 * Never mutates cloud state, never writes credentials to disk.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_DIR = path.resolve(__dirname, '..');

function readProject() {
  const rcPath = path.join(STUDIO_DIR, '.firebaserc');
  if (existsSync(rcPath)) {
    try {
      const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
      if (rc?.projects?.default) return rc.projects.default;
    } catch {
      // fallback
    }
  }
  return 'mdmedia-dev';
}

function getCliAccessToken() {
  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(configPath)) {
    throw new Error('Firebase CLI configuration not found. Run `firebase login`.');
  }

  let cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  let tokens = cfg?.tokens;
  const expiresAt = typeof tokens?.expires_at === 'number' ? tokens.expires_at : 0;

  if (!tokens?.access_token || expiresAt < Date.now() + 60_000) {
    try {
      execFileSync('firebase', ['projects:list', '--json'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
      cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      tokens = cfg?.tokens;
    } catch {
      // continue with whatever token is present
    }
  }

  if (!tokens?.access_token) {
    throw new Error('No Firebase CLI access token found. Run `firebase login`.');
  }

  return tokens.access_token;
}

const PROJECT = readProject();
const accessToken = getCliAccessToken();

const D = '/databases/(default)/documents/';
const t = (email, verified = true) => ({ email, email_verified: verified });
const allow = (ok) => [{ function: 'exists', args: [{ anyValue: {} }], result: { value: ok } }];

const narr = (owner, vis, extra = {}) => ({
  ownerUid: owner,
  title: 'Narration Title',
  sourceMarkdown: '# Markdown',
  transcript: 'Transcript text.',
  voice: 'Kore',
  promptStyle: 'natural',
  adapted: false,
  status: 'ready',
  durationMs: 5000,
  audioPath: `narrations/${owner}/n.wav`,
  timingsPath: `narrations/${owner}/n.timings.json`,
  visibility: vis,
  sharedWith: [],
  authorName: owner,
  authorPhoto: '',
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

const play = (owner, extra = {}) => ({
  ownerUid: owner,
  title: 'Playlist Title',
  description: 'Playlist Description',
  narrationIds: ['n1'],
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

// Firestore test cases: [description, expected, request, functionMocks, existingResource]
const fsCases = [
  // --- 006 / Allowlist and User Profile Access
  ['journey: get own allowlist doc', 'ALLOW', { method: 'get', path: D + 'allowlist/alice@example.test', auth: { uid: 'alice', token: t('alice@example.test') } }, allow(true), { email: 'alice@example.test' }],
  ['journey: get own profile', 'ALLOW', { method: 'get', path: D + 'users/alice', auth: { uid: 'alice', token: t('alice@example.test') } }, allow(true), { uid: 'alice' }],
  ['journey: create own profile', 'ALLOW', { method: 'create', path: D + 'users/alice', auth: { uid: 'alice', token: t('alice@example.test') }, resource: { data: { uid: 'alice', email: 'alice@example.test' } } }, allow(true), null],
  ['journey: non-allowlisted gets own (missing) allowlist doc', 'ALLOW', { method: 'get', path: D + 'allowlist/eve@example.test', auth: { uid: 'eve', token: t('eve@example.test') } }, allow(false), null],
  ['non-allowlisted creates own profile', 'DENY', { method: 'create', path: D + 'users/eve', auth: { uid: 'eve', token: t('eve@example.test') }, resource: { data: { uid: 'eve' } } }, allow(false), null],
  ['read another user allowlist doc', 'DENY', { method: 'get', path: D + 'allowlist/bob@example.test', auth: { uid: 'alice', token: t('alice@example.test') } }, allow(true), { email: 'bob@example.test' }],
  ['unverified email creates profile', 'DENY', { method: 'create', path: D + 'users/alice', auth: { uid: 'alice', token: t('alice@example.test', false) }, resource: { data: { uid: 'alice' } } }, allow(true), null],

  // --- 004 / Client Write Field Allowlist & Create Prohibition
  ['004 bob updates own narration title', 'ALLOW', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'private', { title: 'Renamed', updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['004 bob updates own narration visibility & sharedWith', 'ALLOW', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'shared', { sharedWith: ['alice'], updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['004 bob attempts to forge status/durationMs', 'DENY', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'private', { status: 'ready', durationMs: 999999, updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['004 bob attempts to repoint audioPath', 'DENY', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'private', { audioPath: 'narrations/alice/a.wav', updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['004 bob attempts to inject unknown field', 'DENY', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'private', { featured: true, updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['004 client attempts to create whole narration', 'DENY', { method: 'create', path: D + 'narrations/new-1', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'private') } }, allow(true), null],
  ['004 alice attempts to update bobs narration', 'DENY', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'alice', token: t('alice@example.test') }, resource: { data: narr('bob', 'private', { title: 'Hijack', updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],

  // --- 005 / Real-User Read Gate
  ['005 signed-out visitor gets public narration', 'ALLOW', { method: 'get', path: D + 'narrations/alice-pub', auth: null }, [], narr('alice', 'public')],
  ['005 non-allowlisted eve gets public narration', 'ALLOW', { method: 'get', path: D + 'narrations/alice-pub', auth: { uid: 'eve', token: t('eve@example.test') } }, allow(false), narr('alice', 'public')],
  ['005 allowlisted bob reads shared narration', 'ALLOW', { method: 'get', path: D + 'narrations/alice-shared', auth: { uid: 'bob', token: t('bob@example.test') } }, allow(true), narr('alice', 'shared', { sharedWith: ['bob'] })],
  ['005 non-allowlisted eve denied reading shared narration', 'DENY', { method: 'get', path: D + 'narrations/alice-shared', auth: { uid: 'eve', token: t('eve@example.test') } }, allow(false), narr('alice', 'shared', { sharedWith: ['eve'] })],
  ['005 allowlisted alice reads own private narration', 'ALLOW', { method: 'get', path: D + 'narrations/alice-priv', auth: { uid: 'alice', token: t('alice@example.test') } }, allow(true), narr('alice', 'private')],
  ['005 de-allowlisted owner denied reading own private narration', 'DENY', { method: 'get', path: D + 'narrations/alice2-priv', auth: { uid: 'alice2', token: t('alice2@example.test') } }, allow(false), narr('alice2', 'private')],
  ['005 allowlisted alice reads own playlist', 'ALLOW', { method: 'get', path: D + 'playlists/alice-play', auth: { uid: 'alice', token: t('alice@example.test') } }, allow(true), play('alice')],
  ['005 de-allowlisted owner denied reading own playlist', 'DENY', { method: 'get', path: D + 'playlists/alice2-play', auth: { uid: 'alice2', token: t('alice2@example.test') } }, allow(false), play('alice2')],

  // --- 007 / Share by Resolved UID & Labels
  ['007 bob updates own narration sharedWith & sharedWithLabels', 'ALLOW', { method: 'update', path: D + 'narrations/bob-own', auth: { uid: 'bob', token: t('bob@example.test') }, resource: { data: narr('bob', 'shared', { sharedWith: ['alice'], sharedWithLabels: { alice: 'alice@example.test' }, updatedAt: 2000 }) } }, allow(true), narr('bob', 'private')],
  ['007 allowlisted bob reads narration shared by uid with labels', 'ALLOW', { method: 'get', path: D + 'narrations/alice-shared-uid', auth: { uid: 'bob', token: t('bob@example.test') } }, allow(true), narr('alice', 'shared', { sharedWith: ['bob'], sharedWithLabels: { bob: 'bob@example.test' } })],
];

// Storage test cases: [description, expected, requestObject]
const stCases = [
  ['003 alice (owner) reads public audio', 'ALLOW', {
    expectation: 'ALLOW',
    request: { method: 'get', path: `/b/${PROJECT}.appspot.com/o/narrations/alice/pub.wav`, auth: { uid: 'alice' }, time: new Date().toISOString() },
    resource: { name: 'narrations/alice/pub.wav', bucket: `${PROJECT}.appspot.com`, metadata: { ownerUid: 'alice' }, contentType: 'audio/wav', size: 100 },
  }],
  ['003 signed-out visitor denied public audio', 'DENY', {
    expectation: 'DENY',
    request: { method: 'get', path: `/b/${PROJECT}.appspot.com/o/narrations/alice/pub.wav`, auth: null, time: new Date().toISOString() },
    resource: { name: 'narrations/alice/pub.wav', bucket: `${PROJECT}.appspot.com`, metadata: { ownerUid: 'alice' }, contentType: 'audio/wav', size: 100 },
  }],
  ['003 authenticated non-owner bob denied public audio', 'DENY', {
    expectation: 'DENY',
    request: { method: 'get', path: `/b/${PROJECT}.appspot.com/o/narrations/alice/pub.wav`, auth: { uid: 'bob' }, time: new Date().toISOString() },
    resource: { name: 'narrations/alice/pub.wav', bucket: `${PROJECT}.appspot.com`, metadata: { ownerUid: 'alice' }, contentType: 'audio/wav', size: 100 },
  }],
  ['003 signed-out visitor denied private audio', 'DENY', {
    expectation: 'DENY',
    request: { method: 'get', path: `/b/${PROJECT}.appspot.com/o/narrations/alice/priv.wav`, auth: null, time: new Date().toISOString() },
    resource: { name: 'narrations/alice/priv.wav', bucket: `${PROJECT}.appspot.com`, metadata: { ownerUid: 'alice' }, contentType: 'audio/wav', size: 100 },
  }],
];

async function callRulesTestApi(fileName, content, testCases) {
  const url = `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(PROJECT)}:test`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': PROJECT,
    },
    body: JSON.stringify({
      source: {
        files: [{ name: fileName, content }],
      },
      testSuite: {
        testCases,
      },
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Rules Test API ${fileName} HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  console.log(`\n=== Hosted Firebase Rules Test API Verification (${PROJECT}) ===\n`);

  const firestoreRulesContent = readFileSync(path.join(STUDIO_DIR, 'firestore.rules'), 'utf8');
  const storageRulesContent = readFileSync(path.join(STUDIO_DIR, 'storage.rules'), 'utf8');

  const fsPayload = fsCases.map(([desc, expected, req, mocks, existing]) => ({
    expectation: expected,
    request: { ...req, time: new Date().toISOString() },
    ...(existing ? { resource: { data: existing } } : {}),
    functionMocks: mocks,
  }));

  const stPayload = stCases.map((c) => c[2]);

  let failures = 0;

  try {
    const fsResult = await callRulesTestApi('firestore.rules', firestoreRulesContent, fsPayload);
    console.log(`--- Firestore Rules Parity (${fsCases.length} test cases) ---`);
    (fsResult.testResults ?? []).forEach((r, i) => {
      const [desc, expected] = fsCases[i];
      const actual = r.state === 'SUCCESS' ? expected : expected === 'ALLOW' ? 'DENY' : 'ALLOW';
      const match = actual === expected;
      const statusLabel = match ? 'MATCH' : 'MISMATCH';
      if (!match) failures++;
      console.log(`  [${statusLabel}] expected=${expected.padEnd(5)} hosted=${actual.padEnd(5)} :: ${desc}`);
    });
  } catch (err) {
    console.error('Firestore hosted verification failed:', err);
    process.exit(1);
  }

  try {
    const stResult = await callRulesTestApi('storage.rules', storageRulesContent, stPayload);
    console.log(`\n--- Storage Rules Parity (${stCases.length} test cases) ---`);
    (stResult.testResults ?? []).forEach((r, i) => {
      const [desc, expected] = stCases[i];
      const actual = r.state === 'SUCCESS' ? expected : expected === 'ALLOW' ? 'DENY' : 'ALLOW';
      const match = actual === expected;
      const statusLabel = match ? 'MATCH' : 'MISMATCH';
      if (!match) failures++;
      console.log(`  [${statusLabel}] expected=${expected.padEnd(5)} hosted=${actual.padEnd(5)} :: ${desc}`);
    });
  } catch (err) {
    console.error('Storage hosted verification failed:', err);
    process.exit(1);
  }

  console.log('\n======================================================');
  if (failures === 0) {
    console.log(`✓ ALL HOSTED VERIFICATION CHECKS PASSED (0 mismatches across ${fsCases.length + stCases.length} cases)`);
    process.exit(0);
  } else {
    console.error(`✗ HOSTED VERIFICATION FAILED: ${failures} mismatch(es) detected.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
