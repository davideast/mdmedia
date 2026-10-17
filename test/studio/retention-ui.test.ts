import { expect, it } from 'bun:test';

it('renders the retention settings from saved defaults without errors', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/retention-ui-fixture.tsx'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ passed: true });
});
