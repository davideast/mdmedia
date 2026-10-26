/** Opt-in real HTTP/process tests. See docs/storyboards/cli-plan.md. */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const url = process.env.STORYBOARD_E2E_URL;
const key = process.env.STORYBOARD_E2E_KEY;
const enabled = Boolean(url && key);
const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), 'storyboard-cli-e2e-'));
const created = new Set<string>();
const doc = {
  version: 1,
  premise: 'Teach one concrete idea.',
  beats: [
    {
      id: 'start',
      title: 'See the problem',
      purpose: 'Establish the question',
      summary: 'Compare two designs.',
      script: 'A design communicates before you read it.',
      visual: 'Two different pages',
      notes: 'Keep the contrast',
      status: 'draft',
      estimatedSeconds: null,
      image: '/assets/storyboard/test.png',
    },
    {
      id: 'finish',
      title: 'Try the solution',
      purpose: '',
      summary: 'Show the result.',
      script: 'Choose what the page should communicate.',
      visual: '',
      notes: '',
      status: 'decided',
      estimatedSeconds: 8,
    },
  ],
};
function input(name: string, value: unknown) {
  const file = path.join(temp, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}
async function api(route: string, method = 'GET', body?: unknown, token = key) {
  return fetch(`${url}/api/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function cli(
  args: string[],
  options: {
    stdin?: string;
    key?: string;
  } = {},
) {
  const command = process.env.STORYBOARD_E2E_BUILT
    ? ['node', path.join(root, 'dist/bin.js')]
    : [process.execPath, path.join(root, 'src/bin.ts')];
  const child = Bun.spawn([...command, 'studio', 'storyboard', ...args], {
    cwd: temp,
    env: {
      ...process.env,
      MDMEDIA_STUDIO_URL: url!,
      MDMEDIA_API_KEY: options.key ?? key!,
      XDG_CONFIG_HOME: temp,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
async function ok(args: string[], stdin?: string) {
  const result = await cli([...args, '--json'], { stdin });
  expect({
    code: result.code,
    stderr: result.stderr,
    output: result.code ? result.stdout : '',
  }).toEqual({ code: 0, stderr: '', output: '' });
  return result.json();
}
afterAll(async () => {
  if (enabled)
    for (const id of created) await api(`/storyboards/${id}`, 'DELETE');
  rmSync(temp, { recursive: true, force: true });
});
describe.skipIf(!enabled)(
  'Studio storyboard CLI against a real HTTP server',
  () => {
    it('creates an independent story and reads its exact content through show and list', async () => {
      const before = await (await api('/productions')).json();
      const board = await ok([
        'create',
        '--title',
        'CLI round trip',
        '--input',
        input('story.json', doc),
      ]);
      created.add(board.id);
      expect(board.storyboard.document).toEqual(doc);
      expect(board.storyboard.revision).toBe(1);
      expect((await ok(['show', board.id])).storyboard.document).toEqual(doc);
      const list = await ok(['list']);
      expect(
        list.storyboards.find((s: { id: string }) => s.id === board.id),
      ).toMatchObject({ title: 'CLI round trip', beatCount: 2 });
      const after = await (await api('/productions')).json();
      expect(after.productions).toEqual(before.productions);
    }, 30000);
    it('saves edits with the supplied revision and rejects stale updates without overwriting', async () => {
      const board = await ok(
        ['create', '--title', 'Revision check', '--input', '-'],
        JSON.stringify(doc),
      );
      created.add(board.id);
      const changed = { ...doc, premise: 'A changed premise.' };
      const saved = await ok(
        [
          'update',
          board.id,
          '--revision',
          '1',
          '--title',
          'Renamed',
          '--input',
          '-',
        ],
        JSON.stringify(changed),
      );
      expect(saved.title).toBe('Renamed');
      expect(saved.storyboard.document).toEqual(changed);
      expect(saved.storyboard.revision).toBe(2);
      const stale = await cli([
        'update',
        board.id,
        '--revision',
        '1',
        '--title',
        'Lost edit',
        '--json',
      ]);
      expect(stale.code).toBe(1);
      expect(stale.json().error.code).toBe('storyboard_conflict');
      const renamed = await ok([
        'update',
        board.id,
        '--revision',
        '2',
        '--title',
        'Title only',
      ]);
      expect(renamed.storyboard.document).toEqual(changed);
      expect(renamed.storyboard.revision).toBe(3);
      const missing = await cli([
        'update',
        board.id,
        '--title',
        'Unsafe',
        '--json',
      ]);
      expect(missing.code).toBe(1);
      expect((await ok(['show', board.id])).title).toBe('Title only');
    }, 30000);
    it('adds and patches a beat while preserving every untouched field and beat', async () => {
      const board = await ok([
        'create',
        '--title',
        'Beat editing',
        '--input',
        input('beats.json', doc),
      ]);
      created.add(board.id);
      const newBeat = {
        ...doc.beats[0],
        id: 'middle',
        title: 'Inspect the detail',
      };
      const added = await ok(
        [
          'beat',
          'add',
          board.id,
          '--revision',
          '1',
          '--before',
          'finish',
          '--input',
          '-',
        ],
        JSON.stringify(newBeat),
      );
      expect(
        added.storyboard.document.beats.map((b: { id: string }) => b.id),
      ).toEqual(['start', 'middle', 'finish']);
      const patched = await ok([
        'beat',
        'update',
        board.id,
        'middle',
        '--revision',
        '2',
        '--input',
        input('patch.json', { script: 'Look at this detail.', notes: '' }),
      ]);
      expect(patched.storyboard.document.beats).toEqual([
        doc.beats[0],
        { ...newBeat, script: 'Look at this detail.', notes: '' },
        doc.beats[1],
      ]);
      for (const patch of [
        { id: 'renamed' },
        { unexpected: 'silently dropped' },
      ]) {
        const invalid = await cli([
          'beat',
          'update',
          board.id,
          'middle',
          '--revision',
          '3',
          '--input',
          input('badpatch.json', patch),
          '--json',
        ]);
        expect(invalid.code).toBe(1);
      }
      const duplicate = await cli([
        'beat',
        'add',
        board.id,
        '--revision',
        '3',
        '--input',
        input('dup.json', newBeat),
        '--json',
      ]);
      expect(duplicate.code).toBe(1);
      expect((await ok(['show', board.id])).storyboard.revision).toBe(3);
    }, 30000);
    it('moves beats by identity and requires explicit intent to remove one', async () => {
      const board = await ok([
        'create',
        '--title',
        'Order check',
        '--input',
        input('order.json', doc),
      ]);
      created.add(board.id);
      const moved = await ok([
        'beat',
        'move',
        board.id,
        'finish',
        '--revision',
        '1',
        '--before',
        'start',
      ]);
      expect(moved.storyboard.document.beats).toEqual([
        doc.beats[1],
        doc.beats[0],
      ]);
      const restored = await ok([
        'beat',
        'move',
        board.id,
        'finish',
        '--revision',
        '2',
        '--after',
        'start',
      ]);
      expect(restored.storyboard.document.beats).toEqual(doc.beats);
      for (const flags of [
        ['--before', 'absent'],
        ['--before', 'start', '--after', 'finish'],
      ]) {
        const bad = await cli([
          'beat',
          'move',
          board.id,
          'finish',
          '--revision',
          '3',
          ...flags,
          '--json',
        ]);
        expect(bad.code).toBe(1);
      }
      const refused = await cli([
        'beat',
        'remove',
        board.id,
        'finish',
        '--revision',
        '3',
        '--json',
      ]);
      expect(refused.code).toBe(1);
      const removed = await ok([
        'beat',
        'remove',
        board.id,
        'finish',
        '--revision',
        '3',
        '--yes',
      ]);
      expect(removed.storyboard.document.beats).toEqual([doc.beats[0]]);
      const stale = await cli([
        'beat',
        'remove',
        board.id,
        'start',
        '--revision',
        '3',
        '--yes',
        '--json',
      ]);
      expect(stale.json().error.code).toBe('storyboard_conflict');
    }, 30000);
    it('deletes only with explicit intent and enforces owner and scope restrictions', async () => {
      const board = await ok(['create', '--title', 'Disposable delete check']);
      created.add(board.id);
      const refused = await cli(['delete', board.id, '--json']);
      expect(refused.code).toBe(1);
      const readKey = process.env.STORYBOARD_E2E_READ_KEY!;
      const otherKey = process.env.STORYBOARD_E2E_OTHER_KEY!;
      expect(readKey).toBeTruthy();
      expect(otherKey).toBeTruthy();
      const read = await cli(['show', board.id, '--json'], { key: readKey });
      expect(read.code).toBe(0);
      const forbidden = await cli(['delete', board.id, '--yes', '--json'], {
        key: readKey,
      });
      expect(forbidden.code).toBe(1);
      expect(forbidden.json().error.code).toBe('insufficient_scope');
      expect(forbidden.json().error.message).toContain('studio login');
      for (const args of [
        ['show', board.id, '--json'],
        ['delete', board.id, '--yes', '--json'],
      ]) {
        const other = await cli(args, { key: otherKey });
        expect(other.code).toBe(1);
        expect(other.json().error.code).toBe('storyboard_not_found');
      }
      const invalid = await cli(['show', board.id, '--json'], {
        key: 'invalid-test-key',
      });
      expect(invalid.code).toBe(1);
      expect(invalid.json().error.code).toBe('unauthenticated');
      expect(await ok(['delete', board.id, '--yes'])).toEqual({
        id: board.id,
        deleted: true,
      });
      created.delete(board.id);
      const missing = await cli(['show', board.id, '--json']);
      expect(missing.code).toBe(1);
      expect(missing.json().error.code).toBe('storyboard_not_found');
    }, 30000);
    it('previews exact script or walkthrough narration with voice and delivery without generating', async () => {
      const board = await ok([
        'create',
        '--title',
        'Narration preview',
        '--input',
        input('narrate.json', doc),
      ]);
      created.add(board.id);
      const before = await (await api('/narrations')).json();
      const script = await ok([
        'narrate',
        board.id,
        '--dry-run',
        '--voice',
        'Kore',
        '--delivery',
        'Warm and direct.',
        '--speed',
        '0.9',
      ]);
      expect(script.request.markdown).toBe(
        'A design communicates before you read it.\n\nChoose what the page should communicate.',
      );
      expect(script.beatIds).toEqual(['start', 'finish']);
      expect(script.request.voice).toBe('Kore');
      expect(script.request.promptStyle).toBe('Warm and direct.');
      expect(script.request.speed).toBe(0.9);
      const walk = await ok([
        'narrate',
        board.id,
        '--beat',
        'start',
        '--view',
        'board',
        '--dry-run',
      ]);
      expect(walk.request.markdown).toBe('Compare two designs.');
      expect(walk.beatIds).toEqual(['start']);
      for (const flags of [
        ['--beat', 'absent'],
        ['--view', 'wrong'],
        ['--speed', 'NaN'],
        ['--voice', 'not-a-voice'],
      ]) {
        const result = await cli([
          'narrate',
          board.id,
          '--dry-run',
          ...flags,
          '--json',
        ]);
        expect(result.code).toBe(1);
      }
      const empty = await ok(['create', '--title', 'No words']);
      created.add(empty.id);
      const emptyRead = await cli(['narrate', empty.id, '--dry-run', '--json']);
      expect(emptyRead.code).toBe(1);
      expect(await (await api('/narrations')).json()).toEqual(before);
    }, 60000);
    it.skipIf(process.env.STORYBOARD_E2E_PAID !== '1')(
      'generates one short narration and reuses it for an identical request',
      async () => {
        const spoken = {
          version: 1,
          premise: '',
          beats: [
            {
              ...doc.beats[0],
              id: 'proof',
              title: 'Audio proof',
              script: 'A storyboard helps you plan the story before recording.',
            },
          ],
        };
        const board = await ok([
          'create',
          '--title',
          'CLI audio proof',
          '--input',
          input('spoken.json', spoken),
        ]);
        created.add(board.id);
        const first = await ok([
          'narrate',
          board.id,
          '--voice',
          'Kore',
          '--wait',
          '--timeout',
          '120',
        ]);
        expect(first.status).toBe('ready');
        expect(first.id).toBeTruthy();
        const second = await ok(['narrate', board.id, '--voice', 'Kore']);
        expect(second.id).toBe(first.id);
        const audio = await api(`/narrations/${first.id}/audio`);
        expect(audio.status).toBe(200);
        expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(1000);
        console.log(`Live narration verified and reused: ${first.id}`);
      },
      150000,
    );
    it('rejects malformed documents and missing login without creating a record or exposing credentials', async () => {
      const before = await ok(['list']);
      for (const text of [
        'null',
        'false',
        '[]',
        '{bad json',
        '{"version":2,"premise":"","beats":[]}',
      ]) {
        const result = await cli(
          ['create', '--title', 'Must not exist', '--input', '-', '--json'],
          { stdin: text },
        );
        const payload = result.json();
        if (payload.id) created.add(payload.id);
        expect(result.code).toBe(1);
        expect(payload.error).toBeTruthy();
        expect(result.stdout.includes(key!)).toBe(false);
      }
      expect(await ok(['list'])).toEqual(before);
      const missing = await cli(['list', '--json'], { key: '' });
      expect(missing.code).toBe(1);
      expect(missing.json().error.code).toBe('not_logged_in');
    }, 30000);
    it('lets only one of two concurrent writers save the same revision', async () => {
      const board = await ok([
        'create',
        '--title',
        'Concurrent check',
        '--input',
        input('concurrent.json', doc),
      ]);
      created.add(board.id);
      const results = await Promise.all(
        ['First writer', 'Second writer'].map((title) =>
          cli([
            'update',
            board.id,
            '--revision',
            '1',
            '--title',
            title,
            '--json',
          ]),
        ),
      );
      expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
      const winner = results.find((r) => r.code === 0)!.json();
      expect(results.find((r) => r.code === 1)!.json().error.code).toBe(
        'storyboard_conflict',
      );
      const saved = await ok(['show', board.id]);
      expect(saved.title).toBe(winner.title);
      expect(saved.storyboard.revision).toBe(2);
      expect(saved.storyboard.document).toEqual(doc);
    }, 30000);
    it('rejects a misspelled dry-run flag before it can submit paid narration', async () => {
      const board = await ok([
        'create',
        '--title',
        'Flag validation',
        '--input',
        input('flags.json', doc),
      ]);
      created.add(board.id);
      // Read-only credentials make this red test incapable of paid synthesis.
      const result = await cli(['narrate', board.id, '--dryrun', '--json'], {
        key: process.env.STORYBOARD_E2E_READ_KEY!,
      });
      expect(result.code).toBe(1);
      expect(result.json().error.code).toBe('unknown_option');
      expect(result.json().error.message).toContain('dryrun');
    }, 30000);
  },
);
