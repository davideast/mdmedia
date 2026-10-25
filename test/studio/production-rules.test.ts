import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Pyric evaluates the compiled rules in process, with no sandbox.
import { firestoreRules, type FirestoreCase } from 'pyric/rules';

/**
 * Productions, their cuts and series are owner-only to read, like playlists,
 * and never written by a client: /api/v1 writes them with the Admin SDK after
 * checking that every asset a cut names is the owner's.
 */

const rules = firestoreRules(readFileSync(resolve(import.meta.dir, '../../studio/firestore.rules'), 'utf8'));
const alice = { uid: 'alice', token: { email: 'alice@example.test', email_verified: true } };
const eve = { uid: 'eve', token: { email: 'eve@example.test', email_verified: true } };
const stranger = { uid: 'stranger', token: { email: 'stranger@example.test', email_verified: true } };
/** Alice and Eve are allowlisted; the stranger isn't. */
const allowlist = (allowed: string[]): FirestoreCase['functionMocks'] => allowed.map((uid) => ({ function: 'exists', path: `allowlist/${uid}@example.test`, result: true }));

const production = { ownerUid: 'alice', title: 'Night Wagon: The Argument', slug: 'night-wagon-the-argument', cuts: [], createdAt: 1, updatedAt: 1 };
const cut = { ownerUid: 'alice', productionId: 'pr1', label: 'Take 9', status: 'approved', kind: 'cut', order: 1 };
const series = { ownerUid: 'alice', title: 'Night Wagon', slug: 'night-wagon' };

function check(cases: FirestoreCase[]) {
  const summary = rules.simulate(cases);
  const failed = summary.cases.filter((c) => !c.passed).map((c) => `${c.description}: ${c.decision}`);
  expect(failed).toEqual([]);
  expect(summary.unsupported).toBe(0);
}

describe('production rules', () => {
  for (const [name, path, resource] of [
    ['a production', 'productions/pr1', production],
    ['a cut', 'productions/pr1/cuts/take9', cut],
    ['a series', 'series/se1', series],
  ] as const) {
    it(`let only the owner read ${name}`, () => {
      check([
        { description: `owner gets ${name}`, expectation: 'ALLOW', method: 'get', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
        { description: `owner lists ${name}`, expectation: 'ALLOW', method: 'list', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
        { description: `another user can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: eve, resource, functionMocks: allowlist(['eve']) },
        { description: `a signed-out reader can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: null, resource },
        { description: `the owner off the allowlist can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: { ...stranger, uid: 'alice' }, resource, functionMocks: allowlist([]) },
      ]);
    });

    it(`let no client write ${name}, not even its owner`, () => {
      check([
        { description: `owner creates ${name}`, expectation: 'DENY', method: 'create', path, auth: alice, data: resource, functionMocks: allowlist(['alice']) },
        { description: `owner updates ${name}`, expectation: 'DENY', method: 'update', path, auth: alice, resource, data: { ...resource, title: 'x' }, functionMocks: allowlist(['alice']) },
        { description: `owner deletes ${name}`, expectation: 'DENY', method: 'delete', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
        { description: `another user creates ${name}`, expectation: 'DENY', method: 'create', path, auth: eve, data: { ...resource, ownerUid: 'eve' }, functionMocks: allowlist(['eve']) },
      ]);
    });
  }

  it('keep the authored modules and the compiled rules in step', () => {
    const modules = readFileSync(resolve(import.meta.dir, '../../studio/firestore.modules.rules'), 'utf8');
    for (const match of ['match /productions/{productionId}', 'match /cuts/{cutId}', 'match /series/{seriesId}']) {
      expect(modules).toContain(match);
    }
  });
});
