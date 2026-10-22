import { describe, expect, it } from 'bun:test';
import { lineRenderKey, parseStory } from '../../src/story/index.js';
import type { Line, StoryScript } from '../../src/story/index.js';

const PROVIDER = { name: 'gemini', model: 'gemini-3.8-flash-tts' };

const story = (body: string, delivery = 'quick, defensive') => `---
title: Keys
narrator:
  voice: Charon
  delivery: warm
cast:
  MAYA:
    voice: Kore
    delivery: ${delivery}
  DAD:
    voice: Puck
    delivery: dry
---

${body}`;

const BODY = [
  '### One',
  '*(calm)* The bus pulled away.',
  '**MAYA** *(panicked)*: Wait!',
  '**DAD** *(amused)*: It left.',
  '**MAYA** *(sulking)*: I saw.',
  '**DAD** *(gentle)*: Next one is in ten minutes.',
  '### Two',
  '*(calm)* Ten minutes later.',
  '**MAYA** *(relieved)*: Finally.',
];

async function keys(markdown: string): Promise<Map<string, string>> {
  const { script } = await parseStory(markdown, { path: 'keys.md' });
  const all = (script as StoryScript).chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const out = new Map<string, string>();
  for (const line of all) out.set(line.text, await lineRenderKey(line, script!, PROVIDER));
  return out;
}

const changed = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter((text) => b.has(text) && a.get(text) !== b.get(text));

describe('lineRenderKey', () => {
  it('is stable for the same input', async () => {
    const a = await keys(story(BODY.join('\n\n')));
    const b = await keys(story(BODY.join('\n\n')));
    expect([...a.values()]).toEqual([...b.values()]);
    expect([...a.values()].every((k) => /^line:[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it('editing a line changes it and the next two lines in its scene, and nothing else', async () => {
    const before = await keys(story(BODY.join('\n\n')));
    const edited = BODY.map((l) => (l === '**MAYA** *(panicked)*: Wait!' ? '**MAYA** *(panicked)*: Wait for me!' : l));
    const after = await keys(story(edited.join('\n\n')));
    expect(changed(before, after)).toEqual(['It left.', 'I saw.']);
    expect(after.has('Wait for me!')).toBe(true);
  });

  it('the first line of a scene has no context, so the previous scene does not reach it', async () => {
    const before = await keys(story(BODY.join('\n\n')));
    const edited = BODY.map((l) => (l.startsWith('**DAD** *(gentle)*') ? '**DAD** *(gentle)*: Next one is in five minutes.' : l));
    const after = await keys(story(edited.join('\n\n')));
    expect(changed(before, after)).toEqual([]);
  });

  it('inserting a pause changes no key', async () => {
    const before = await keys(story(BODY.join('\n\n')));
    const withPause = [...BODY.slice(0, 3), '```pause\n1s\n```', ...BODY.slice(3)];
    const after = await keys(story(withPause.join('\n\n')));
    expect(changed(before, after)).toEqual([]);
  });

  it("changing a character's default delivery changes only that character's lines", async () => {
    const before = await keys(story(BODY.join('\n\n')));
    const after = await keys(story(BODY.join('\n\n'), 'slow and careful'));
    expect(changed(before, after)).toEqual(['Wait!', 'I saw.', 'Finally.']);
  });
});
