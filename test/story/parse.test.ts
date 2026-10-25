import { describe, expect, it } from 'bun:test';
import { lexer } from 'marked';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../src/story/index.js';
import type { Diagnostic, Line, StoryScript } from '../../src/story/index.js';

const FIXTURES = join(import.meta.dir, 'fixtures');
const GOLDEN = join(import.meta.dir, 'golden');
const STORIES = ['embarrassing-day', 'lunch-voices', 'lighthouse'];
const read = (name: string) => readFileSync(join(FIXTURES, `${name}.md`), 'utf8');
const lines = (script: StoryScript) =>
  script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
const errors = (diagnostics: Diagnostic[]) => diagnostics.filter((d) => d.severity === 'error');

describe('lexer positions', () => {
  it('reproduces each fixture body from the raw text of its top-level tokens', () => {
    for (const name of STORIES) {
      const markdown = read(name);
      const body = markdown.slice(/^---\n[\s\S]*?\n---\n/.exec(markdown)![0].length);
      expect(lexer(body).map((t) => t.raw).join('')).toBe(body);
    }
  });
});

describe('golden scripts', () => {
  for (const name of STORIES) {
    it(`${name} matches its golden script.json`, async () => {
      const { script, diagnostics } = await parseStory(read(name), { path: `${name}.md` });
      expect(errors(diagnostics)).toEqual([]);
      const golden = join(GOLDEN, `${name}.script.json`);
      const actual = JSON.stringify(script, null, 2) + '\n';
      if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, actual);
      expect(actual).toBe(readFileSync(golden, 'utf8'));
    });
  }
});

describe('The Most Embarrassing Day of My Life', () => {
  it('voices narration as Milo, marked as narration', async () => {
    const { script } = await parseStory(read('embarrassing-day'), { path: 'embarrassing-day.md' });
    const all = lines(script!);
    expect(script!.narrator).toBe('MILO');
    expect(all).toHaveLength(290);
    const narration = all.filter((l) => l.narration);
    expect(narration).toHaveLength(163);
    expect(narration.every((l) => l.speaker === 'MILO')).toBe(true);
  });

  it('gives every scene its music cue and keeps headings out of speech', async () => {
    const { script } = await parseStory(read('embarrassing-day'), { path: 'embarrassing-day.md' });
    const scenes = script!.chapters.flatMap((c) => c.scenes);
    expect(scenes.map((s) => s.title)).toEqual([
      '7:43 a.m.', 'First period', 'Two weeks earlier', 'Lunch', '1:45 p.m.', '2:25 p.m.', 'After the assembly', 'Three weeks later',
    ]);
    expect(scenes.every((s) => s.music && s.music.length > 10)).toBe(true);
    expect(lines(script!).some((l) => l.text.includes('Embarrassing Day of My Life'))).toBe(false);
  });

  it('strips inline markdown for speech and keeps it for display', async () => {
    const { script } = await parseStory(read('lighthouse'), { path: 'lighthouse.md' });
    const wren = lines(script!).find((l) => l.text.includes('Wren'))!;
    expect(wren.text).toBe('The Wren. Nineteen years ago. It never came back.');
    expect(wren.display).toBe('The *Wren*. Nineteen years ago. It never came back.');
  });
});

describe('names', () => {
  it('reads a list of other names into meta.names', async () => {
    const { script, diagnostics } = await parseStory('---\ntitle: T\nnames: [Priya Shah, Westfield]\nnarrator:\n  voice: Charon\n---\n\n*(calm)* Hi.\n', { path: 't.md' });
    expect(diagnostics).toEqual([]);
    expect(script!.meta.names).toEqual(['Priya Shah', 'Westfield']);
  });

  it('rejects names that are not a list', async () => {
    const { diagnostics } = await parseStory('---\ntitle: T\nnames: Priya\nnarrator:\n  voice: Charon\n---\n\n*(calm)* Hi.\n', { path: 't.md' });
    expect(diagnostics.map((d) => [d.code, d.source?.line])).toEqual([['missing-field', 3]]);
  });
});

describe('narration cues', () => {
  it('reads a cue at the start of a narration paragraph', async () => {
    const markdown = '---\ntitle: T\nnarrator:\n  voice: Charon\n---\n\n*(hushed, heavy)* But at our table, everything had gone quiet.\n';
    const { script, diagnostics } = await parseStory(markdown, { path: 't.md' });
    expect(diagnostics).toEqual([]);
    const [line] = lines(script!);
    expect(line).toMatchObject({ speaker: 'NARRATOR', narration: true, cue: 'hushed, heavy', text: 'But at our table, everything had gone quiet.' });
  });
});

describe('pauses', () => {
  it('accepts 0ms for an interruption', async () => {
    const markdown = '---\ntitle: T\nnarrator:\n  voice: Charon\n---\n\n*(calm)* Hello.\n\n```pause\n0ms\n```\n';
    const { script } = await parseStory(markdown, { path: 't.md' });
    const pause = script!.chapters[0]!.scenes[0]!.segments[1]!;
    expect(pause).toMatchObject({ kind: 'pause', durationMs: 0 });
  });
});

describe('errors and warnings', () => {
  const check = async (name: string) => (await parseStory(read(`errors/${name}`), { path: `${name}.md` })).diagnostics;

  it('missing-front-matter', async () => {
    const d = await check('missing-front-matter');
    expect(d.map((x) => x.code)).toEqual(['missing-front-matter']);
    expect(d[0]!.source).toMatchObject({ line: 1, column: 1 });
  });

  it('bad-yaml, at the broken line', async () => {
    const d = await check('bad-yaml');
    expect(d[0]!.code).toBe('bad-yaml');
    expect(d[0]!.source!.line).toBeGreaterThanOrEqual(3);
  });

  it('unknown-key, at the misspelled key', async () => {
    const d = await check('unknown-key');
    expect(d.map((x) => x.code)).toEqual(['unknown-key']);
    expect(d[0]!.source).toMatchObject({ line: 3, column: 1 });
    expect(d[0]!.message).toContain('narator');
  });

  it('missing-field for a missing title, missing-voice for a cast member with neither a voice nor a brief', async () => {
    const d = await check('missing-field');
    expect(d.map((x) => x.code).sort()).toEqual(['missing-field', 'missing-voice']);
    expect(d.some((x) => x.message.includes('title'))).toBe(true);
    expect(d.some((x) => x.message.includes('MAYA needs a brief') && x.source!.line === 5)).toBe(true);
  });

  it('missing-field, for a missing narrator', async () => {
    const { diagnostics } = await parseStory('---\ntitle: T\n---\n\nHello.\n', { path: 't.md' });
    expect(diagnostics.map((x) => x.code)).toEqual(['missing-field']);
  });

  it('unknown-speaker, at the name', async () => {
    const d = await check('unknown-speaker');
    expect(errors(d).map((x) => x.code)).toEqual(['unknown-speaker']);
    expect(errors(d)[0]!.source).toMatchObject({ line: 12, column: 3, endColumn: 8 });
  });

  it('unknown-speaker, for a narrator who is not in the cast', async () => {
    const { diagnostics } = await parseStory('---\ntitle: T\nnarrator: MILO\n---\n\nHello.\n', { path: 't.md' });
    expect(diagnostics.map((x) => x.code)).toEqual(['unknown-speaker']);
  });

  it('bad-duration, for a pause and for the gap', async () => {
    expect((await check('bad-duration')).map((x) => x.code)).toEqual(['bad-duration']);
    const { diagnostics } = await parseStory('---\ntitle: T\ngap: later\nnarrator:\n  voice: Charon\n---\n\n*(calm)* Hi.\n', { path: 't.md' });
    expect(diagnostics.map((x) => x.code)).toEqual(['bad-duration']);
  });

  it('misplaced-music, after the scene has started', async () => {
    const d = await check('misplaced-music');
    expect(d.map((x) => x.code)).toEqual(['misplaced-music']);
    expect(d[0]!.source!.line).toBe(11);
  });

  it('missing-cue is a warning on narration and dialogue, and the script still parses', async () => {
    const { script, diagnostics } = await parseStory(read('errors/missing-cue'), { path: 'missing-cue.md' });
    expect(script).toBeDefined();
    expect(diagnostics.map((x) => [x.code, x.severity, x.source!.line])).toEqual([
      ['missing-cue', 'warning', 10],
      ['missing-cue', 'warning', 12],
    ]);
  });

  it('placeholder-cue is an error, so the director repairs it', async () => {
    const md = '---\ntitle: Flat\nnarrator:\n  voice: Charon\ncast:\n  MAYA:\n    voice: Kore\n---\n\n*(cue)* The bus was already moving.\n\n**MAYA** *(Delivery)*: Wait!\n\n**MAYA** *(cueing up, nervous)*: Wait!\n';
    const { script, diagnostics } = await parseStory(md, { path: 'p.md' });
    expect(script).toBeUndefined();
    expect(diagnostics.map((x) => [x.code, x.severity, x.source!.line])).toEqual([
      ['placeholder-cue', 'error', 10],
      ['placeholder-cue', 'error', 12],
    ]);
  });

  it('returns no script when there are errors', async () => {
    const { script } = await parseStory(read('errors/unknown-speaker'), { path: 'u.md' });
    expect(script).toBeUndefined();
  });
});
