import { expect, it } from 'bun:test';
it('saves video sequences with safe continuation, regeneration, recovery and scoped API access', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/video-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true, providerCalls: 5 });
});
