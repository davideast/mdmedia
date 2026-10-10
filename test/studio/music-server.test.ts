import { expect, it } from 'bun:test';
it('saves music versions with measured audio, scoped access, idempotency and safe receipt recovery', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/music-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true, providerCalls: 4, retrievalCalls: 1 });
}, 60_000);
