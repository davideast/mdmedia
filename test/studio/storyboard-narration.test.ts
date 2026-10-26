import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
it('routes storyboard audio through the narration engine with durable deduplication', () => {
  const result=spawnSync(process.execPath,['test/studio/fixtures/storyboard-narration-fixture.ts'],{cwd:process.cwd(),encoding:'utf8'});
  expect(result.stdout + result.stderr).toContain('PASS:');
  expect(result.status).toBe(0);
});
