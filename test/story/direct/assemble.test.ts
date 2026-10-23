import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseStory } from '../../../src/story/index.js';
import type { Line, StoryScript } from '../../../src/story/index.js';
import { assembleStory, type CastPlan, type SceneDraft } from '../../../src/story/direct/assemble.js';

const fixture = readFileSync(join(import.meta.dir, '..', 'fixtures', 'embarrassing-day.md'), 'utf8');

const shape = (script: StoryScript) => ({
  meta: script.meta,
  narrator: script.narrator,
  cast: script.cast,
  scenes: script.chapters.flatMap((c) => c.scenes).map((s) => ({
    title: s.title,
    music: s.music,
    lines: s.segments.map((seg) => (seg.kind === 'line' ? [(seg as Line).speaker, (seg as Line).cue, (seg as Line).text, (seg as Line).narration] : ['pause', seg.durationMs])),
  })),
});

describe('assembleStory', () => {
  it('rebuilds the fixture from its cast and scenes', async () => {
    const front = parse(fixture.split('\n---\n')[0]!.replace(/^---\n/, '')) as Record<string, any>;
    const plan: CastPlan = {
      title: front.title,
      narrator: { character: front.narrator },
      cast: front.cast,
      names: [],
      scenes: [],
    };
    const drafts: SceneDraft[] = fixture
      .split('\n### ')
      .slice(1)
      .map((chunk) => {
        const [title, ...rest] = chunk.split('\n');
        const body = rest.join('\n');
        const music = /```music\n([\s\S]*?)\n```/.exec(body)?.[1];
        return { title: title!.trim(), music, body: body.replace(/```music\n[\s\S]*?\n```/, '') };
      });
    const assembled = assembleStory(plan, drafts);
    const a = (await parseStory(assembled, { path: 'a.md' })).script!;
    const b = (await parseStory(fixture, { path: 'b.md' })).script!;
    expect(shape(a)).toEqual(shape(b));
  });

  it('writes a separate narrator and the names list into the front matter', async () => {
    const md = assembleStory(
      { title: 'T', narrator: { voice: 'Charon', delivery: 'warm' }, cast: { MAYA: { voice: 'Kore', delivery: 'quick' } }, names: ['Westfield'], scenes: [] },
      [{ title: 'One', music: 'soft piano', body: '*(calm)* Hello.\n\n**MAYA** *(bright)*: Hi!' }]
    );
    const { script, diagnostics } = await parseStory(md, { path: 't.md' });
    expect(diagnostics).toEqual([]);
    expect(script!.narrator).toBe('NARRATOR');
    expect(script!.meta.names).toEqual(['Westfield']);
    expect(script!.chapters[0]!.scenes[0]!.music).toBe('soft piano');
  });
});
