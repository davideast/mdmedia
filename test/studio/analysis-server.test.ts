import { expect, it } from 'bun:test';
it('stores video analyses with scoped sources, receipts before polling, recovery without paid retries, and a follow-on narration', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/analysis-server-fixture.ts'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 90_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ passed: true, uploads: 1, narrations: 2 });
}, 90_000);
