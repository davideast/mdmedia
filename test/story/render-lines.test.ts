import { describe, expect, it } from 'bun:test';
import { parseStory, renderLines } from '../../src/story/index.js';
import type { StoryScript } from '../../src/story/index.js';
import { memoryCache, scriptedTranscriber, toneSpeaker } from './fakes.js';

const story = (lines: string[]) => `---
title: Lines
narrator:
  voice: Charon
cast:
  MAYA:
    voice: Kore
  DAD:
    voice: Puck
---

### One

${lines.join('\n\n')}
`;

const BODY = [
  '**MAYA** *(panicked)*: Wait!',
  '**DAD** *(amused)*: It left.',
  '**MAYA** *(sulking)*: I saw.',
  '**DAD** *(gentle)*: Next one is in ten minutes.',
];

async function script(lines = BODY): Promise<StoryScript> {
  return (await parseStory(story(lines), { path: 'lines.md' })).script!;
}

describe('renderLines', () => {
  it('voices every line once when every take passes, and caches them as accepted', async () => {
    const speaker = toneSpeaker();
    const cache = memoryCache();
    const out = await renderLines(await script(), { speaker, transcriber: scriptedTranscriber(), cache });
    expect(speaker.calls).toHaveLength(4);
    expect([...out.values()].every((r) => r.result.ok && r.result.attempts === 1 && !r.result.cached)).toBe(true);
    expect([...cache.entries.values()].every((e) => e.accepted)).toBe(true);
  });

  it('tells the transcriber the cast names, without the narrator role', async () => {
    const transcriber = scriptedTranscriber();
    await renderLines(await script(), { speaker: toneSpeaker(), transcriber, cache: memoryCache() });
    expect(transcriber.names).toHaveLength(4);
    expect(transcriber.names.every((n) => n.join() === 'Maya,Dad')).toBe(true);
  });

  it("adds the story's other names after the cast", async () => {
    const md = story(BODY).replace('title: Lines\n', 'title: Lines\nnames: [Priya Shah, Westfield]\n');
    const parsed = (await parseStory(md, { path: 'lines.md' })).script!;
    const transcriber = scriptedTranscriber();
    await renderLines(parsed, { speaker: toneSpeaker(), transcriber, cache: memoryCache() });
    expect(transcriber.names[0]).toEqual(['Maya', 'Dad', 'Priya Shah', 'Westfield']);
  });

  it('retakes once after a mismatch, then caches the passing take', async () => {
    const speaker = toneSpeaker();
    const cache = memoryCache();
    const transcriber = scriptedTranscriber((text, call) => (text === 'I saw.' && call === 1 ? 'I saw it.' : undefined));
    const out = await renderLines(await script(), { speaker, transcriber, cache });
    const line = [...out.values()].find((r) => r.result.text === 'I saw.')!.result;
    expect(line).toMatchObject({ ok: true, attempts: 2 });
    expect(speaker.calls.filter((c) => c.text === 'I saw.')).toHaveLength(2);
    expect(cache.entries.get(line.key)!.accepted).toBe(true);
  });

  it('stops after two retakes, keeps the closest take, and does not accept it', async () => {
    const cache = memoryCache();
    const transcriber = scriptedTranscriber((text, call) =>
      text === 'Next one is in ten minutes.' ? (call === 2 ? 'Next one is in minutes.' : 'Next one') : undefined
    );
    const out = await renderLines(await script(), { speaker: toneSpeaker(), transcriber, cache });
    const line = [...out.values()].find((r) => r.result.text === 'Next one is in ten minutes.')!.result;
    expect(line).toMatchObject({ ok: false, attempts: 3, missing: ['10'], heard: 'Next one is in minutes.' });
    expect(cache.entries.get(line.key)!.accepted).toBe(false);
  });

  it('falls back to the cue alone when the full note is refused', async () => {
    const speaker = toneSpeaker({ refuse: (req) => req.text === 'It left.' && req.note.includes('Just before this') });
    const out = await renderLines(await script(), { speaker, transcriber: scriptedTranscriber(), cache: memoryCache() });
    const line = [...out.values()].find((r) => r.result.text === 'It left.')!.result;
    expect(line).toMatchObject({ level: 1, ok: true });
    expect(speaker.calls.filter((c) => c.text === 'It left.').map((c) => c.note)).toEqual([expect.stringContaining('Just before'), 'amused']);
  });

  it('stands in a second of silence when every note is refused, and keeps building', async () => {
    const speaker = toneSpeaker({ refuse: (req) => req.text === 'Wait!' });
    const out = await renderLines(await script(), { speaker, transcriber: scriptedTranscriber(), cache: memoryCache() });
    const line = [...out.values()].find((r) => r.result.text === 'Wait!')!.result;
    expect(line).toMatchObject({ refused: true, ok: false, durationMs: 1000 });
    expect([...out.values()].filter((r) => r.result.ok)).toHaveLength(3);
  });

  it('reuses accepted takes and redoes the rest on the next run', async () => {
    const cache = memoryCache();
    const failing = scriptedTranscriber((text) => (text === 'I saw.' ? 'nope' : undefined));
    await renderLines(await script(), { speaker: toneSpeaker(), transcriber: failing, cache });
    const speaker = toneSpeaker();
    const out = await renderLines(await script(), { speaker, transcriber: scriptedTranscriber(), cache });
    expect(speaker.calls.map((c) => c.text)).toEqual(['I saw.']);
    expect([...out.values()].filter((r) => r.result.cached)).toHaveLength(3);
  });

  it('editing one line redoes it and the next two in its scene only', async () => {
    const cache = memoryCache();
    await renderLines(await script(), { speaker: toneSpeaker(), transcriber: scriptedTranscriber(), cache });
    const edited = BODY.map((l) => (l.endsWith('Wait!') ? '**MAYA** *(panicked)*: Wait for me!' : l));
    const speaker = toneSpeaker();
    await renderLines(await script(edited), { speaker, transcriber: scriptedTranscriber(), cache });
    expect(speaker.calls.map((c) => c.text).sort()).toEqual(['I saw.', 'It left.', 'Wait for me!']);
  });
});
