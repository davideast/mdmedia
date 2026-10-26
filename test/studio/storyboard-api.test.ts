import { expect, it } from 'bun:test';
it('stores independent storyboards with ownership and revision checks', () => {
  const result = Bun.spawnSync([process.execPath, 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/storyboard-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(result.stdout.toString()).toContain('PASS:');
});
