import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { castVoices } from '../../../src/story/cast.js';
import { comicScript, voiceComic } from '../../../src/story/comic/voices.js';
import { castingSpeaker, fakeJudge, testFacts, memoryCache, scriptedTranscriber, toneSpeaker } from '../fakes.js';

const dir = join(import.meta.dir, '..', 'fixtures');

describe('comic voices', async () => {
  const uncast = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!;
  const { script: story } = await castVoices(uncast, { speaker: castingSpeaker(), judge: fakeJudge(), facts: testFacts, cache: memoryCache(), voices: ['Puck', 'Kore', 'Leda'] });
  const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast: story.cast })).comic!;
  const items = comic.pages.flatMap((p) => p.panels.flatMap((panel) => panel.items.map((item, i) => ({ panel, item, i }))));
  const voiced = items.filter((x) => x.item.kind !== 'sfx');

  it('makes one line per caption and balloon, none for sound effects, a scene per page', () => {
    const script = comicScript(comic, story);
    const lines = script.chapters[0]!.scenes.flatMap((s) => s.segments);
    expect(lines).toHaveLength(voiced.length);
    expect(items.some((x) => x.item.kind === 'sfx')).toBe(true);
    expect(script.chapters[0]!.scenes.map((s) => s.id)).toEqual(['page-1', 'page-2', 'page-3', 'page-4']);
    expect(lines[0]).toMatchObject({ id: '1.1-0', speaker: 'MILO', narration: true });
    expect(lines[1]).toMatchObject({ id: '1.1-1', speaker: 'HARPER', narration: false, cue: 'loud and delighted, calling across the cafeteria' });
  });

  it("voices captions with the narrator's voice and gives each line the line before it as context", async () => {
    const speaker = toneSpeaker();
    const rendered = await voiceComic(comic, story, { speaker, transcriber: scriptedTranscriber(), cache: memoryCache() });
    expect(rendered.size).toBe(voiced.length);
    const caption = speaker.calls.find((c) => c.text.startsWith('By lunch'))!;
    expect(caption.voice).toBe(story.cast.MILO!.voice);
    const second = speaker.calls.find((c) => c.text === 'Milo! Dude!')!;
    expect(second.note).toContain('By lunch, things were going better');
  });

  it('draws nothing new on a second run with the same cache', async () => {
    const cache = memoryCache();
    await voiceComic(comic, story, { speaker: toneSpeaker(), transcriber: scriptedTranscriber(), cache });
    const again = toneSpeaker();
    const rendered = await voiceComic(comic, story, { speaker: again, transcriber: scriptedTranscriber(), cache });
    expect(again.calls).toHaveLength(0);
    expect([...rendered.values()].every((r) => r.result.cached)).toBe(true);
  });
});
