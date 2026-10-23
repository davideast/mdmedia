import { describe, expect, it } from 'bun:test';
import { buildMixPlan, LEAD_MS, MUSIC_PREFIX, OUTRO_MS, parseStory, renderMusic } from '../../src/story/index.js';
import type { StoryScript, StoryTimeline } from '../../src/story/index.js';
import { envelopeExpression, mixGraph } from '../../src/story/node/index.js';
import { fakeComposer, memoryCache } from './fakes.js';

const md = `---
title: Music
narrator:
  voice: Charon
---

### One

\`\`\`music
bright morning theme
\`\`\`

*(calm)* Morning.

### Two

*(calm)* No music here.

### Three

\`\`\`music
bright morning theme
\`\`\`

*(calm)* The theme again.

### Four

\`\`\`music
tense strings
\`\`\`

*(calm)* Trouble.
`;

const script = async () => (await parseStory(md, { path: 'm.md' })).script as StoryScript;

describe('renderMusic', () => {
  it('composes each distinct cue once, with the instrumental prefix, and caches it', async () => {
    const composer = fakeComposer();
    const cache = memoryCache();
    const { clips, results } = await renderMusic(await script(), { composer, cache });
    expect(composer.prompts.sort()).toEqual([MUSIC_PREFIX + 'bright morning theme', MUSIC_PREFIX + 'tense strings']);
    expect([...clips.keys()]).toEqual(['00/00', '00/02', '00/03']);
    expect(results.every((r) => r.ok && !r.cached)).toBe(true);

    const again = fakeComposer();
    const second = await renderMusic(await script(), { composer: again, cache });
    expect(again.prompts).toEqual([]);
    expect(second.results.every((r) => r.cached)).toBe(true);
  });

  it('reports a failed cue and keeps the other scenes', async () => {
    const { clips, results } = await renderMusic(await script(), { composer: fakeComposer((p) => p.includes('tense')), cache: memoryCache() });
    expect([...clips.keys()]).toEqual(['00/00', '00/02']);
    expect(results.find((r) => r.scene === '00/03')).toMatchObject({ ok: false, error: 'composer failed' });
  });
});

describe('buildMixPlan', () => {
  const timeline = {
    schema: 'mdmedia.story.timeline/1',
    durationMs: 60_000,
    chapters: [],
    scenes: [
      { id: 'a', chapterId: '00', startMs: 0, endMs: 20_000 },
      { id: 'b', chapterId: '00', startMs: 20_400, endMs: 40_000 },
      { id: 'c', chapterId: '00', startMs: 40_400, endMs: 60_000 },
    ],
    lines: [],
  } as StoryTimeline;
  const clip = (name: string) => ({ bytes: new TextEncoder().encode(name), mimeType: 'audio/mpeg' });

  it('starts each bed at its scene with the lead envelope, and adds the theme as an outro', () => {
    const plan = buildMixPlan(timeline, new Uint8Array(4), new Map([['a', clip('theme')], ['c', clip('tense')]]));
    expect(plan.beds.map((b) => [new TextDecoder().decode(b.audio), b.atMs])).toEqual([['theme', 0], ['tense', 40_400], ['theme', 59_000]]);
    expect(plan.beds[0]!.envelope).toEqual([[0, 1], [LEAD_MS, 1], [LEAD_MS + 1500, 0.3], [LEAD_MS + 16_000, 0.3], [LEAD_MS + 22_000, 0]]);
    expect(plan.beds[2]!.envelope).toEqual([[0, 0.3], [1000, 1], [8000, 1], [13_000, 0]]);
    expect(plan.durationMs).toBe(60_000 + OUTRO_MS);
  });

  it('has no beds and no outro without music', () => {
    const plan = buildMixPlan(timeline, new Uint8Array(4), new Map());
    expect(plan.beds).toEqual([]);
    expect(plan.durationMs).toBe(60_000);
  });
});

describe('ffmpeg graph', () => {
  it('turns an envelope into a piecewise-linear expression in seconds', () => {
    expect(envelopeExpression([[0, 1], [3000, 1], [4500, 0.3]])).toBe('if(lt(t,3),1+(0)*(t-0)/3,if(lt(t,4.5),1+(-0.7)*(t-3)/1.5,0.3))');
    expect(envelopeExpression([])).toBe('1');
  });

  it('mixes beds after the voice and trims to the plan length', () => {
    const graph = mixGraph({ voice: new Uint8Array(), beds: [{ audio: new Uint8Array(), mimeType: 'audio/mpeg', atMs: 2500, envelope: [[0, 1]] }], durationMs: 10_000 });
    expect(graph).toContain('adelay=2500:all=1[m0]');
    expect(graph).toContain('amix=inputs=2:duration=longest:normalize=0');
    expect(graph).toContain('atrim=0:10.000[out]');
    expect(mixGraph({ voice: new Uint8Array(), beds: [], durationMs: 1000 })).not.toContain('amix');
  });
});
