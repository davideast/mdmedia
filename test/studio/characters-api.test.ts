import { expect, it } from 'bun:test';
it('stores character versions once each, owner-only, and links productions to them as their cast', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/characters-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString().trim().split('\n')[0])).toMatchObject({ passed: true });
}, 60_000);
