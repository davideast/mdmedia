import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Pyric evaluates the compiled rules in process, with no sandbox.
import { firestoreRules, type FirestoreCase } from 'pyric/rules';

/**
 * Review comments (threads, their messages and options), the decision log and
 * agents' heartbeats are owner-only to read, so the cut viewer can listen
 * live, and never written by a client: /api/v1 anchors comments on the
 * resolved cut and keeps statuses in step.
 */

const rules = firestoreRules(readFileSync(resolve(import.meta.dir, '../../studio/firestore.rules'), 'utf8'));
const alice = { uid: 'alice', token: { email: 'alice@example.test', email_verified: true } };
const eve = { uid: 'eve', token: { email: 'eve@example.test', email_verified: true } };
const allowlist = (allowed: string[]): FirestoreCase['functionMocks'] => allowed.map((uid) => ({ function: 'exists', path: `allowlist/${uid}@example.test`, result: true }));

const owned = { ownerUid: 'alice', productionId: 'pr1' };
const docs = [
  ['a thread', 'productions/pr1/threads/th1', { ...owned, cutId: 'take5', text: 'Too long a pause.', status: 'open' }],
  ['a message', 'productions/pr1/threads/th1/messages/m1', { ...owned, threadId: 'th1', author: 'agent:editor', text: 'Option A closes it.' }],
  ['an option', 'productions/pr1/threads/th1/suggestions/s1', { ...owned, threadId: 'th1', title: 'Close the gap', state: 'proposed' }],
  ['a decision', 'productions/pr1/decisions/d1', { ...owned, kind: 'decision', text: 'One performance per sentence.' }],
  ['a heartbeat', 'commentAgents/ag1', { ownerUid: 'alice', agent: 'editor', productionId: null, seenAt: 1 }],
] as const;

function check(cases: FirestoreCase[]) {
  const summary = rules.simulate(cases);
  const failed = summary.cases.filter((c) => !c.passed).map((c) => `${c.description}: ${c.decision}`);
  expect(failed).toEqual([]);
  expect(summary.unsupported).toBe(0);
}

describe('comment rules', () => {
  for (const [name, path, resource] of docs) {
    it(`let only the owner read ${name}, live`, () => {
      check([
        { description: `owner gets ${name}`, expectation: 'ALLOW', method: 'get', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
        { description: `owner lists ${name}`, expectation: 'ALLOW', method: 'list', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
        { description: `another user can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: eve, resource, functionMocks: allowlist(['eve']) },
        { description: `another user can't list ${name}`, expectation: 'DENY', method: 'list', path, auth: eve, resource, functionMocks: allowlist(['eve']) },
        { description: `a signed-out reader can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: null, resource },
        { description: `the owner off the allowlist can't get ${name}`, expectation: 'DENY', method: 'get', path, auth: alice, resource, functionMocks: allowlist([]) },
      ]);
    });

    it(`let no client write ${name}, not even its owner`, () => {
      check([
        { description: `owner creates ${name}`, expectation: 'DENY', method: 'create', path, auth: alice, data: resource, functionMocks: allowlist(['alice']) },
        { description: `owner updates ${name}`, expectation: 'DENY', method: 'update', path, auth: alice, resource, data: { ...resource, text: 'x' }, functionMocks: allowlist(['alice']) },
        { description: `owner deletes ${name}`, expectation: 'DENY', method: 'delete', path, auth: alice, resource, functionMocks: allowlist(['alice']) },
      ]);
    });
  }

  it('keep the authored modules and the compiled rules in step', () => {
    const modules = readFileSync(resolve(import.meta.dir, '../../studio/firestore.modules.rules'), 'utf8');
    const compiled = readFileSync(resolve(import.meta.dir, '../../studio/firestore.rules'), 'utf8');
    for (const match of ['match /threads/{threadId}', 'match /messages/{messageId}', 'match /suggestions/{suggestionId}', 'match /decisions/{decisionId}', 'match /commentAgents/{agentId}']) {
      expect(modules).toContain(match);
      expect(compiled).toContain(match);
    }
  });
});
