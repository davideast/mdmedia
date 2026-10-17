import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The render needs studio's own React pair. CI installs only the repository
// root, so there the test is skipped rather than failed.
const studioReact = existsSync(resolve(import.meta.dir, '../../studio/node_modules/react-dom/package.json'));

it.skipIf(!studioReact)('renders the retention settings from saved defaults without errors', () => {
  const result = Bun.spawnSync(['bun', 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/retention-ui-fixture.tsx'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  expect(JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)).toMatchObject({ passed: true });
});
