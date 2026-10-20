import { expect, it } from 'bun:test';
it('stores productions, their cuts and their media through the API, owner-only, with byte ranges for video', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/productions-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ passed: true });
}, 60_000);
