import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { fidelity } from '../../../src/story/direct/fidelity.js';

const dir = join(import.meta.dir, '..', 'fixtures');
const raw = readFileSync(join(dir, 'embarrassing-day.raw.md'), 'utf8');
const story = readFileSync(join(dir, 'embarrassing-day.md'), 'utf8');

async function check(markdown: string, text = raw) {
  const { script } = await parseStory(markdown, { path: 'story.md' });
  return fidelity(text, markdown, script!);
}

const gapText = (f: Awaited<ReturnType<typeof check>>) => f.gaps.map((g) => g.words.join(' '));

describe('fidelity', () => {
  it('finds the beats the hand adaptation dropped, and allows tags, labels, the title and the shown ketchup line', async () => {
    const f = await check(story);
    expect(gapText(f)).toEqual([
      'a middle school story about friendship popularity and 1 spectacularly bad decision',
      'harper continued',
      'she smiled',
      'harper pointed toward the laptop on the sound table',
      'mp4',
      'harper stared',
      'i blinked',
      'she held up the screen',
      'i stared at her',
    ]);
    const reasons = new Set(f.missing.filter((m) => m.allowed).map((m) => m.reason));
    expect(reasons).toEqual(new Set(['title', 'speech-tag', 'label', 'replaced']));
    expect(f.missing.find((m) => m.words.join(' ').startsWith('june called'))).toMatchObject({ allowed: true, reason: 'speech-tag' });
    expect(f.added).toEqual([expect.objectContaining({ allowed: true })]);
  });

  it('reports a deleted sentence', async () => {
    const cut = story.replace('Some battles just weren\'t worth winning.', '');
    expect(gapText(await check(cut))).toContain('some battles just weren\'t worth winning');
  });

  it('reports a reworded word as a cut and an addition', async () => {
    const f = await check(story.replace('I needed a rebrand.', 'I needed a new name.'));
    expect(gapText(f)).toContain('rebrand');
    expect(gapText(f)).toContain('new name');
  });

  it('does not accept a replaced sentence unless an added line shows it', async () => {
    const unmarked = story.replace('<!-- director: added -->\n\n', '');
    const f = await check(unmarked);
    expect(gapText(f)).toContain('is too');
    expect(f.missing.some((m) => m.reason === 'replaced')).toBe(false);
  });
});
