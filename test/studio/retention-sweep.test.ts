import { expect, it } from 'bun:test';

it('deletes only expired, unlocked, finished items, with everything they own, within a per-run limit', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/retention-sweep-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ passed: true });
});
