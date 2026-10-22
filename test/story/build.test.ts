import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStory, linePath, slugify } from '../../src/story/index.js';
import type { StoryBuild, StoryTimeline } from '../../src/story/index.js';
import { memoryCache, memorySink, passThroughRuntime, scriptedTranscriber, toneSpeaker } from './fakes.js';

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
