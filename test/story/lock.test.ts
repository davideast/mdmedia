import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStory } from '../../src/story/index.js';
import { drawComic } from '../../src/story/comic/draw.js';
import { parseComic } from '../../src/story/comic/parse.js';
import { renderLines } from '../../src/story/render-lines.js';
import { addToComicLock, readComicLock } from '../../src/story/node/lock.js';
import { fakeImageModel, fakeVision, memoryCache, scriptedTranscriber, toneSpeaker } from './fakes.js';

const dir = join(import.meta.dir, 'fixtures');
const cast = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!.cast;
const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast })).comic!;
const art = (id: string) => ({ bytes: new TextEncoder().encode(`approved ${id}`), mimeType: 'image/webp' });

describe('locked panels', () => {
  it('uses a locked panel as it is: never drawn or checked, whatever the checks ask', async () => {
    const image = fakeImageModel();
    const vision = fakeVision(() => true); // every question fails
    const result = await drawComic(comic, cast, { image, vision, cache: memoryCache(), locked: new Map([['3.4', art('3.4')]]) });
    const panel = result.panels.find((p) => p.id === '3.4')!;
    expect(panel).toMatchObject({ locked: true, ok: true, attempts: 0 });
    expect(new TextDecoder().decode(result.images.get('3.4')!.bytes)).toBe('approved 3.4');
    expect(image.requests.some((r) => r.prompt.includes('June has just understood'))).toBe(false);
    expect(vision.asks.some((a) => a.questions.some((q) => q.includes('June has just understood')))).toBe(false);
  });

  it('draws nothing at all, not even the sheet or staging, when every panel is locked', async () => {
    const image = fakeImageModel();
    const locked = new Map(comic.pages.flatMap((p) => p.panels).map((p) => [p.id, art(p.id)]));
    await drawComic(comic, cast, { image, vision: fakeVision(), cache: memoryCache(), locked });
    expect(image.requests).toHaveLength(0);
  });
});

describe('locked lines', () => {
  it('uses a locked take as it is, without voicing or checking it', async () => {
    const script = (await parseStory(readFileSync(join(dir, 'lighthouse.md'), 'utf8'), { path: 'l.md' })).script!;
    const first = script.chapters[0]!.scenes[0]!.segments.find((s) => s.kind === 'line')!;
    const speaker = toneSpeaker();
    const approved = new Uint8Array(4800);
    const rendered = await renderLines(script, { speaker, transcriber: scriptedTranscriber(), cache: memoryCache(), locked: new Map([[first.id, approved]]) });
    expect(rendered.get(first.id)!.result).toMatchObject({ locked: true, ok: true, attempts: 0 });
    expect(rendered.get(first.id)!.pcm).toBe(approved);
    expect(speaker.calls.some((c) => c.text === (first as { text: string }).text)).toBe(false);
  });
});

describe('the lock file', () => {
  it('round-trips panels, cast and lines, leaves out unlocked ids, and refuses a changed file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'story-lock-'));
    const comicPath = join(root, 'lunch.md');
    await addToComicLock(comicPath, { images: new Map([['1.1', art('1.1')], ['1.2', art('1.2')]]), cast: { HARPER: 'Kore' }, lines: new Map([['1.1-0', new Uint8Array(480)]]) });
    const lock = await readComicLock(comicPath, ['1.2']);
    expect([...lock.images.keys()]).toEqual(['1.1']);
    expect(lock.cast).toEqual({ HARPER: 'Kore' });
    expect(lock.lines.get('1.1-0')!.byteLength).toBe(480);
    writeFileSync(join(root, 'lunch.lock', 'panel-1-1.webp'), 'tampered');
    await expect(readComicLock(comicPath)).rejects.toThrow('has changed on disk');
  });
});
