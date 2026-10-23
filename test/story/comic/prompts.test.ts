import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { NO_TEXT_QUESTION, panelPrompt, panelQuestions, sheetPrompt } from '../../../src/story/comic/prompts.js';

const dir = join(import.meta.dir, '..', 'fixtures');

describe('comic prompts and checks', async () => {
  const cast = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!.cast;
  const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast })).comic!;
  const all = comic.pages.flatMap((p) => p.panels);
  const panel = (id: string) => all.find((p) => p.id === id)!;

  it('asks a two-shot about both looks, text, the sides and its acting note', () => {
    const q = panelQuestions(panel('3.4'), cast);
    expect(q[0]).toStartWith('Does June match this description');
    expect(q[1]).toStartWith('Does Milo match this description');
    expect(q).toContain(NO_TEXT_QUESTION);
    expect(q).toContain('Is June on the left of the frame and Milo on the right?');
    expect(q.at(-1)).toContain('June has just understood he betrayed her trust');
  });

  it('asks an edit-chain close-up about framing and the same face', () => {
    const q = panelQuestions(panel('3.2'), cast);
    expect(q).toContain('Is this an extreme close-up where one face fills nearly the whole frame?');
    expect(q).toContain('Is this the same framing and the same face as the previous panel shown?');
  });

  it('never asks for space for balloons, and marks the dialogue as not to be written', () => {
    for (const p of all) {
      const prompt = panelPrompt(p, 'flat', cast, ['sheet'], undefined);
      expect(prompt.toLowerCase()).not.toContain('leave space');
      expect(prompt).toContain('No text anywhere');
    }
    expect(panelPrompt(panel('3.4'), 'flat', cast, ['sheet', 'staging', 'previous'], panel('3.3'))).toContain('do not write any of these words');
  });

  it('uses the right framing phrase and an edit prompt for continues', () => {
    expect(panelPrompt(panel('3.1'), 'flat', cast, ['sheet'])).toContain('extreme close-up; the face fills the frame');
    expect(panelPrompt(panel('1.1'), 'flat', cast, ['sheet'])).toContain('the top quarter of the image shows only background scenery');
    expect(panelPrompt(panel('3.2'), 'flat', cast, [])).toStartWith('Edit this comic panel.');
  });

  it('draws the sheet from every character with a look', () => {
    expect(sheetPrompt('flat', cast)).toContain('6 characters standing side by side');
  });
});
