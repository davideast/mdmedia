import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStory, linePath, slugify } from '../../src/story/index.js';
import type { StoryBuild, StoryTimeline } from '../../src/story/index.js';
import { castingSpeaker, fakeComposer, fakeJudge, memoryCache, memorySink, passThroughRuntime, scriptedTranscriber, toneSpeaker } from './fakes.js';

const markdown = readFileSync(join(import.meta.dir, 'fixtures', 'lighthouse.md'), 'utf8');

describe('buildStory', () => {
  it('writes the output tree with durations that add up', async () => {
    const out = memorySink();
    const events: string[] = [];
    const { build } = await buildStory({
      source: { path: 'lighthouse.md', markdown },
      out,
      speaker: toneSpeaker(),
      transcriber: scriptedTranscriber(),
      runtime: passThroughRuntime,
      cache: memoryCache(),
      onEvent: (e) => events.push(e.type),
    });
    const slug = slugify("The Keeper's Log");
    expect(slug).toBe('the-keeper-s-log');
    for (const path of ['build.json', 'script.json', 'timeline.json', `audio/${slug}.mp3`, 'audio/master.wav', 'text/transcript.md']) {
      expect(out.files.has(path)).toBe(true);
    }
    const timeline = JSON.parse(out.files.get('timeline.json') as string) as StoryTimeline;
    expect(timeline.lines).toHaveLength(16);
    for (const line of timeline.lines) expect(out.files.has(linePath(line.id))).toBe(true);
    expect(build!.summary).toMatchObject({ lines: 16, cached: 0, retakes: 0, fallbacks: 0, refused: 0, failures: 0 });
    expect(Math.abs(build!.summary.audioSeconds * 1000 - timeline.durationMs)).toBeLessThan(100);
    expect(events.filter((e) => e === 'line-done')).toHaveLength(16);
    expect(events.at(-1)).toBe('build-done');
    const transcript = out.files.get('text/transcript.md') as string;
    expect(transcript).toContain('# The Keeper\'s Log');
    expect(transcript).toContain('**MARA**: Your mother talks too much.');
  });

  it('casts a character with a brief and no voice, and records the auditions in build.json', async () => {
    const briefed = markdown.replace(/(  MARA:\n)    voice: \S+\n/, "$1    brief: Mara, seventy, a lighthouse keeper's widow from Stromness in Orkney; a low, salt-cured voice.\n");
    expect(briefed).not.toBe(markdown);
    const out = memorySink();
    const { build } = await buildStory({
      source: { path: 'lighthouse.md', markdown: briefed },
      out,
      speaker: castingSpeaker(),
      transcriber: { model: 'any', transcribe: async () => '' },
      judge: fakeJudge({ Gacrux: 9 }),
      runtime: passThroughRuntime,
      cache: memoryCache(),
    });
    expect(build!.casting.map((c) => [c.id, c.voice])).toEqual([['MARA', 'Gacrux']]);
    expect(build!.casting[0]!.ranked).toHaveLength(30);
  });

  it('stops before voicing anything when a character needs casting and there is no judge', async () => {
    const briefed = markdown.replace(/(  MARA:\n)    voice: \S+\n/, '$1    brief: Mara, seventy, from Stromness.\n');
    await expect(
      buildStory({ source: { path: 'l.md', markdown: briefed }, out: memorySink(), speaker: toneSpeaker(), transcriber: scriptedTranscriber(), runtime: passThroughRuntime, cache: memoryCache() })
    ).rejects.toThrow('MARA need a voice');
  });

  it('records a line that still fails its check after retakes', async () => {
    const out = memorySink();
    const { build } = await buildStory({
      source: { path: 'lighthouse.md', markdown },
      out,
      speaker: toneSpeaker(),
      transcriber: scriptedTranscriber((text) => (text === 'I know the night. I wrote it down.' ? 'I know the night.' : undefined)),
      runtime: passThroughRuntime,
      cache: memoryCache(),
    });
    expect(build!.summary).toMatchObject({ failures: 1, retakes: 2 });
    const written = JSON.parse(out.files.get('build.json') as string) as StoryBuild;
    expect(written.lines.find((l) => !l.ok)).toMatchObject({ missing: ['i', 'wrote', 'it', 'down'], attempts: 3 });
  });

  it('adds scene music: clips written, leads in the timeline, beds in the mix plan', async () => {
    const markdown = readFileSync(join(import.meta.dir, 'fixtures', 'embarrassing-day.md'), 'utf8')
      .split('\n### 1:45 p.m.')[0]!; // the first four scenes, each with a music cue
    const out = memorySink();
    const composer = fakeComposer();
    const { build } = await buildStory({
      source: { path: 'day.md', markdown },
      out,
      speaker: toneSpeaker(),
      transcriber: scriptedTranscriber(),
      runtime: passThroughRuntime,
      cache: memoryCache(),
      composer,
    });
    expect(composer.prompts).toHaveLength(4);
    expect(build!.summary.musicClips).toBe(4);
    expect(build!.models.music).toBe('fake-music');
    expect(build!.music.every((m) => m.ok)).toBe(true);
    expect(['audio/music/00-00.mp3', 'audio/music/00-03.mp3'].every((p) => out.files.has(p))).toBe(true);
    const timeline = JSON.parse(out.files.get('timeline.json') as string) as StoryTimeline;
    for (const scene of timeline.scenes) {
      const first = timeline.lines.find((l) => l.id.startsWith(`${scene.id}/`))!;
      expect(first.startMs - scene.startMs).toBe(3000);
    }
    expect(passThroughRuntime.lastPlan!.beds).toHaveLength(5); // four scenes and the outro
    expect(Math.abs(build!.summary.audioSeconds * 1000 - (timeline.durationMs + 12_000))).toBeLessThanOrEqual(100);
  });

  it('builds voices only with music: false', async () => {
    const composer = fakeComposer();
    const { build } = await buildStory({
      source: { path: 'day.md', markdown: readFileSync(join(import.meta.dir, 'fixtures', 'embarrassing-day.md'), 'utf8').split('\n### First period')[0]! },
      out: memorySink(),
      speaker: toneSpeaker(),
      transcriber: scriptedTranscriber(),
      runtime: passThroughRuntime,
      cache: memoryCache(),
      composer,
      music: false,
    });
    expect(composer.prompts).toHaveLength(0);
    expect(build!.summary.musicClips).toBe(0);
    expect(passThroughRuntime.lastPlan!.beds).toEqual([]);
  });

  it('stops before rendering when the story has errors', async () => {
    const speaker = toneSpeaker();
    const { build, diagnostics } = await buildStory({
      source: { path: 'bad.md', markdown: '---\ntitle: Bad\n---\n\nHello.\n' },
      out: memorySink(),
      speaker,
      transcriber: scriptedTranscriber(),
      runtime: passThroughRuntime,
      cache: memoryCache(),
    });
    expect(build).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(['missing-field']);
    expect(speaker.calls).toHaveLength(0);
  });
});
