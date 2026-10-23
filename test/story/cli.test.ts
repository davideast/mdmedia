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
    expect(text).toContain('16 lines, 0 cached, 0 retakes, 0 fallbacks, 0 failing, 0 music clips');
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

  it('makes no music with --no-music', async () => {
    const { fakeComposer } = await import('./fakes.js');
    const composer = fakeComposer();
    const markdown = fixture('embarrassing-day');
    const code = await runStoryBuild(
      { file: markdown, out: mkdtempSync(joinPath(tmpdir(), 'story-cli-')), music: false },
      { ...deps(), composer },
      () => {}
    );
    expect([EXIT.ok, EXIT.failingChecks]).toContain(code);
    expect(composer.prompts).toHaveLength(0);
  });

  it('exits 1 with the diagnostics when the story has errors', async () => {
    let text = '';
    const code = await runStoryBuild({ file: fixture('errors/unknown-speaker'), out: mkdtempSync(joinPath(tmpdir(), 'story-cli-')) }, deps(), (t) => { text += t; });
    expect(code).toBe(EXIT.storyErrors);
    expect(text).toContain('unknown-speaker');
  });
});

describe('mdmedia story direct', async () => {
  const { runStoryDirect, EXIT } = await import('../../src/cli/story-command.js');
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { CAST_INSTRUCTION } = await import('../../src/story/direct/prompts.js');

  const raw = 'The Bus\n\nThe bus pulled away. "Wait!" Maya shouted.\n';
  const plan = {
    title: 'The Bus',
    narrator: { voice: 'Charon', delivery: 'warm' },
    cast: { MAYA: { voice: 'Kore', delivery: 'quick' } },
    names: [],
    scenes: [{ title: 'One', firstWords: 'The bus pulled away.', music: 'strings' }],
  };
  const writer = (scene: string) => ({
    model: 'fake',
    async generate({ system }: { system: string }) { return system === CAST_INSTRUCTION ? JSON.stringify(plan) : scene; },
  });

  it('writes the story file and exits 0 when it is clean', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'story-direct-'));
    writeFileSync(joinPath(dir, 'raw.md'), raw);
    let text = '';
    const code = await runStoryDirect(
      { file: joinPath(dir, 'raw.md'), out: joinPath(dir, 'out', 'story.md') },
      writer('*(brisk)* The bus pulled away.\n\n**MAYA** *(panicked)*: Wait!'),
      (t) => { text += t + '\n'; }
    );
    expect(code).toBe(EXIT.ok);
    expect(text).toContain('no problems');
    expect(readFileSync(joinPath(dir, 'out', 'story.md'), 'utf8')).toContain('**MAYA** *(panicked)*: Wait!');
  });

  it('still writes the file, and exits 1, when problems remain', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'story-direct-'));
    writeFileSync(joinPath(dir, 'raw.md'), raw);
    let text = '';
    const code = await runStoryDirect({ file: joinPath(dir, 'raw.md'), out: joinPath(dir, 'story.md') }, writer('The bus left.'), (t) => { text += t + '\n'; });
    expect(code).toBe(EXIT.storyErrors);
    expect(text).toContain('✗ One:');
    expect(readFileSync(joinPath(dir, 'story.md'), 'utf8')).toContain('The bus left.');
  });
});

describe('mdmedia story check on a comic script', async () => {
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  it('checks the comic against the cast of the story it names', async () => {
    const { code, out } = await run(fixture('comic-lunch'));
    expect(code).toBe(0);
    expect(out).toEndWith('no problems');
  });

  it('reports an unknown speaker at its position', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'story-comic-'));
    copyFileSync(fixture('embarrassing-day'), joinPath(dir, 'embarrassing-day.md'));
    writeFileSync(joinPath(dir, 'comic.md'), '---\ntitle: T\nstory: embarrassing-day.md\nstyle: flat\n---\n\n## Page 1\n\nlayout: 1\n\n### Panel 1\n\n> A. Center: JUNE.\n\n**PRIYA** *(calm)*: Hi.\n');
    const { code, out } = await run(joinPath(dir, 'comic.md'));
    expect(code).toBe(1);
    expect(out).toContain('comic.md:15:3 error unknown-speaker PRIYA is not in the story\'s cast.');
  });
});

describe('mdmedia story draw', async () => {
  const { runStoryDraw, EXIT } = await import('../../src/cli/story-command.js');
  const { fakeImageModel, fakeVision, memoryCache } = await import('./fakes.js');
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  it('writes the art, comic.json, draw.json and the preview, and exits 0', async () => {
    const out = mkdtempSync(joinPath(tmpdir(), 'story-draw-'));
    let text = '';
    const code = await runStoryDraw({ file: fixture('comic-lunch'), out }, { image: fakeImageModel(), vision: fakeVision(), cache: memoryCache() }, (t) => { text += t + '\n'; });
    expect(code).toBe(EXIT.ok);
    for (const f of ['art/sheet.png', 'art/staging-1.png', 'art/panel-3-2.png', 'comic.json', 'draw.json', 'preview.html']) expect(existsSync(joinPath(out, 'comic', f))).toBe(true);
    const comic = JSON.parse(readFileSync(joinPath(out, 'comic', 'comic.json'), 'utf8'));
    expect(comic.pages[2].panels[3].heads.map((h: { id: string }) => h.id)).toEqual(['JUNE', 'MILO']);
    expect(text).toContain('21 panels, 0 cached, 0 redraws, 0 failing');
  });

  it('exits 4 when a panel still fails a check', async () => {
    const out = mkdtempSync(joinPath(tmpdir(), 'story-draw-'));
    const vision = fakeVision((img, q) => img.includes('Wide close-up of June') && q === 'Is the image free of speech balloons, captions and written words (apart from school signs or banners)?');
    const code = await runStoryDraw({ file: fixture('comic-lunch'), out }, { image: fakeImageModel(), vision, cache: memoryCache() }, () => {});
    expect(code).toBe(EXIT.failingChecks);
    expect(readFileSync(joinPath(out, 'comic', 'preview.html'), 'utf8')).toContain('1 still failing a check');
  });
});
