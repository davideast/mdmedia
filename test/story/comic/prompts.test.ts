import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { NO_TEXT_QUESTION, ONE_IMAGE_QUESTION, hairOf, stagingPrompt, visualLook, panelPrompt, panelQuestions, sheetPrompt } from '../../../src/story/comic/prompts.js';

const dir = join(import.meta.dir, '..', 'fixtures');

describe('comic prompts and checks', async () => {
  const cast = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!.cast;
  const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast })).comic!;
  const all = comic.pages.flatMap((p) => p.panels);
  const panel = (id: string) => all.find((p) => p.id === id)!;

  it('asks a two-shot about both looks, text, the sides and its acting note', () => {
    const q = panelQuestions(panel('3.4'), cast);
    expect(q[0]).toStartWith('Is June recognizably this character, judging only hair, face and main outfit');
    expect(q[1]).toStartWith('Is Milo recognizably this character, judging only hair, face and main outfit');
    expect(q).toContain(NO_TEXT_QUESTION);
    expect(q).toContain(ONE_IMAGE_QUESTION);
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

  it('describes characters to the checker without ages or body details', () => {
    expect(
      visualLook('a wiry 14-year-old Japanese girl with spiky short black hair in a stubby ponytail; red track jacket over a navy school uniform, scraped knees, white running shoes')
    ).toBe('a Japanese girl with spiky short black hair in a stubby ponytail; red track jacket over a navy school uniform, white running shoes');
    expect(visualLook('a small, skinny eleven-year-old English girl with a frizzy copper bob')).toBe('a English girl with a frizzy copper bob');
    for (const q of panelQuestions(panel('3.4'), cast)) expect(q).not.toMatch(/year-old/);
  });

  it("asks about each character's hair, the detail that drifts", () => {
    expect(hairOf('a 13-year-old boy with messy curly brown hair, freckles and big eyebrows')).toBe('messy curly brown hair');
    expect(hairOf('a tall girl with long wavy strawberry-blonde hair and a white headband; varsity jacket')).toBe('long wavy strawberry-blonde hair');
    expect(hairOf('a teacher in his forties with a mustache; sweater vest')).toBeUndefined();
    expect(panelQuestions(panel('3.4'), cast)).toContain('Does Milo have messy curly brown hair, as far as it is visible?');
  });

  it('draws a staging image with the sides its panels use, and the rules', () => {
    const prompt = stagingPrompt('flat', 'Side view across a lunch table.', cast, ['JUNE', 'MILO'], { JUNE: 'left', MILO: 'right' }, 'June stays on the left.');
    expect(prompt).toContain('Placement: June on the left of the frame, Milo on the right of the frame.');
    expect(prompt).toContain('June stays on the left.');
  });
});

