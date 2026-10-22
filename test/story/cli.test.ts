import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { checkStory } from '../../src/cli/story-command.js';
import { resolveSmartCliArgv } from '../../src/cli/command.js';

const fixture = (name: string) => join(import.meta.dir, 'fixtures', `${name}.md`);

async function run(file: string, json = false) {
  let out = '';
  const code = await checkStory(file, json, (text) => { out += text; });
  return { code, out };
}

describe('mdmedia story check', () => {
  it('exits 0 with warnings only', async () => {
    const { code, out } = await run(fixture('errors/missing-cue'));
    expect(code).toBe(0);
    expect(out).toContain('missing-cue.md:10:1 warning missing-cue');
  });

  it('exits 0 and says so when there are no problems', async () => {
    const { code, out } = await run(fixture('lunch-voices'));
    expect(code).toBe(0);
    expect(out).toEndWith('no problems');
  });

  it('exits 1 on an error and prints file:line:col severity code message', async () => {
    const { code, out } = await run(fixture('errors/unknown-speaker'));
    expect(code).toBe(1);
    expect(out).toMatch(/unknown-speaker\.md:12:3 error unknown-speaker MAYOR is not in the cast\./);
  });

  it('prints a JSON array with --json', async () => {
    const { code, out } = await run(fixture('errors/unknown-speaker'), true);
    expect(code).toBe(1);
    const diagnostics = JSON.parse(out);
    expect(diagnostics[0]).toMatchObject({ code: 'unknown-speaker', severity: 'error', source: { line: 12, column: 3 } });
  });

  it('exits 1 for a file it cannot read', async () => {
    expect((await run(fixture('does-not-exist'))).code).toBe(1);
  });

  it('is never chosen by output-extension routing', () => {
    expect(resolveSmartCliArgv(['story', 'check', 'a.md'])).toEqual(['story', 'check', 'a.md']);
    expect(resolveSmartCliArgv(['-i', 'story.md', '-o', 'story.mp3'])[0]).toBe('music');
  });
});

describe('mdmedia story build', async () => {
  const { runStoryBuild, EXIT } = await import('../../src/cli/story-command.js');
  const { memoryCache, passThroughRuntime, scriptedTranscriber, toneSpeaker } = await import('./fakes.js');
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  const deps = (mishear?: (text: string) => string | undefined) => ({
    speaker: toneSpeaker(),
    transcriber: scriptedTranscriber(mishear),
    runtime: passThroughRuntime,
    cache: memoryCache(),
  });

  it('exits 0 and writes the build when every line passes', async () => {
    const out = mkdtempSync(joinPath(tmpdir(), 'story-cli-'));
    let text = '';
    const code = await runStoryBuild({ file: fixture('lighthouse'), out }, deps(), (t) => { text += t + '\n'; });
    expect(code).toBe(EXIT.ok);
    expect(existsSync(joinPath(out, 'build.json'))).toBe(true);
    expect(text).toContain('16 lines, 0 cached, 0 retakes, 0 fallbacks, 0 failing');
  });

  it('exits 4 when a line still fails its check, and lists it with --json', async () => {
    const out = mkdtempSync(joinPath(tmpdir(), 'story-cli-'));
    let text = '';
    const code = await runStoryBuild(
      { file: fixture('lighthouse'), out, json: true },
      deps((t) => (t === 'Which ship was his?' ? 'Which ship?' : undefined)),
      (t) => { text += t; }
    );
    expect(code).toBe(EXIT.failingChecks);
    const summary = JSON.parse(text);
    expect(summary.summary.failures).toBe(1);
    expect(summary.failing[0]).toMatchObject({ text: 'Which ship was his?', missing: ['was', 'his'] });
    expect(JSON.parse(readFileSync(joinPath(out, 'build.json'), 'utf8')).summary.failures).toBe(1);
  });

  it('exits 1 with the diagnostics when the story has errors', async () => {
    let text = '';
    const code = await runStoryBuild({ file: fixture('errors/unknown-speaker'), out: mkdtempSync(joinPath(tmpdir(), 'story-cli-')) }, deps(), (t) => { text += t; });
    expect(code).toBe(EXIT.storyErrors);
    expect(text).toContain('unknown-speaker');
  });
});
