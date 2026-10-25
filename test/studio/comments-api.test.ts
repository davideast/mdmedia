import { expect, it } from 'bun:test';
it('stores review comments through the API: anchored on the cut, claimed by agents, with options, timed replies and decisions', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/comments-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true });
}, 60_000);
