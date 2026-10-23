import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { drawComic } from '../../../src/story/comic/draw.js';
import { fakeImageModel, fakeVision, memoryCache } from '../fakes.js';

const dir = join(import.meta.dir, '..', 'fixtures');

describe('drawComic', async () => {
  const cast = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!.cast;
  const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast })).comic!;

  it('draws the sheet, one staging image and all 21 panels, with head boxes', async () => {
    const image = fakeImageModel();
    const result = await drawComic(comic, cast, { image, vision: fakeVision(), cache: memoryCache() });
    expect(image.requests).toHaveLength(1 + 1 + 21);
    expect(result.stagings).toHaveLength(1);
    expect(result.panels.every((p) => p.ok && p.attempts === 1)).toBe(true);
    expect(result.panels.find((p) => p.id === '3.4')!.heads.map((h) => h.id)).toEqual(['JUNE', 'MILO']);
  });

  it('gives a panel the sheet, its page staging and the panel before it; a continue gets only its source', async () => {
    const image = fakeImageModel();
    const result = await drawComic(comic, cast, { image, vision: fakeVision(), cache: memoryCache() });
    const refs = new Map(result.panels.map((p) => [p.id, p.references]));
    expect(refs.get('1.1')).toEqual(['sheet']);
    expect(refs.get('1.2')).toEqual(['sheet', '1.1']);
    expect(refs.get('3.1')).toEqual(['sheet', 'staging-1']);
    expect(refs.get('3.4')).toEqual(['sheet', 'staging-1', '3.3']);
    expect(refs.get('3.2')).toEqual(['3.1']);
    const edit = image.requests.find((r) => r.prompt.startsWith('Edit this comic panel.') && r.prompt.includes('the almost-smile is gone'))!;
    expect(edit.references).toHaveLength(1);
    expect(edit.references[0]).toContain('img#');
  });

  it('redraws a panel that fails a check, twice at most, and keeps the take with the most yes answers', async () => {
    const image = fakeImageModel();
    // Panel 3.4's first two takes fail one question; every take fails "on the left" so it never fully passes.
    const vision = fakeVision((img, q) => img.includes('June pulls back') && q.startsWith('Is June on the left'));
    const result = await drawComic(comic, cast, { image, vision, cache: memoryCache() });
    const p = result.panels.find((x) => x.id === '3.4')!;
    expect(p).toMatchObject({ attempts: 3, ok: false });
    expect(p.answers.filter((a) => !a)).toHaveLength(1);
  });

  it('redraws a staging image that is off model before any panel uses it', async () => {
    const image = fakeImageModel();
    let stagingTakes = 0;
    // The first staging take has June off model; the second is fine.
    const vision = fakeVision((img, q) => {
      if (!img.includes('They sit calmly')) return false;
      if (q.startsWith('Does June')) stagingTakes++;
      return q.startsWith('Does June') && stagingTakes === 1;
    });
    const result = await drawComic(comic, cast, { image, vision, cache: memoryCache() });
    expect(result.stagings[0]).toMatchObject({ attempts: 2, ok: true });
    const stagingRequests = image.requests.flatMap((r, i) => (r.prompt.includes('They sit calmly') ? [i] : []));
    const firstPanelWithStaging = image.requests.findIndex((r) => r.prompt.includes('Extreme close-up: only June'));
    expect(stagingRequests).toHaveLength(2);
    expect(Math.max(...stagingRequests)).toBeLessThan(firstPanelWithStaging);
  });

  it('draws nothing on a second run with the same cache', async () => {
    const cache = memoryCache();
    await drawComic(comic, cast, { image: fakeImageModel(), vision: fakeVision(), cache });
    const again = fakeImageModel();
    const vision = fakeVision();
    const result = await drawComic(comic, cast, { image: again, vision, cache });
    expect(again.requests).toHaveLength(0);
    expect(vision.asks).toHaveLength(0);
    expect(result.panels.every((p) => p.cached)).toBe(true);
  });

  it('asks a continue panel its questions with the source panel shown first', async () => {
    const vision = fakeVision();
    await drawComic(comic, cast, { image: fakeImageModel(), vision, cache: memoryCache() });
    const edit = vision.asks.find((a) => a.questions.some((q) => q.startsWith('Is this the same framing')))!;
    expect(edit.labels).toEqual(['Previous panel', 'Panel to check']);
  });
});
