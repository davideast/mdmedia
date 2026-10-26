import { expect, it } from 'bun:test';

it('runs storyboard CLI processes through HTTP with isolated persistence and no paid providers', async () => {
  const child = Bun.spawn([process.execPath, 'run', '--tsconfig-override', './studio/tsconfig.json', 'test/studio/fixtures/storyboard-server-fixture.ts', '--cli'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, errors: code ? stderr : '' }).toEqual({ code: 0, errors: '' });
  expect(stdout).toContain('PASS: automatic CLI HTTP suite');
}, 120000);
