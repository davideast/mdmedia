import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryNote, parseStory } from '../../src/story/index.js';
import type { Line } from '../../src/story/index.js';

const md = readFileSync(join(import.meta.dir, 'fixtures', 'lunch-voices.md'), 'utf8');

describe('deliveryNote', async () => {
  const { script } = await parseStory(md, { path: 'lunch-voices.md' });
  const lines = script!.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const byText = (text: string) => lines.find((l) => l.text === text)!;

  it('starts a scene with no context', () => {
    expect(deliveryNote(lines[0]!, script!, 0)).toBe(
      'a funny, quick-talking thirteen-year-old boy telling his own story. warm, smug, building up the good news'
    );
  });

  it('carries the character, the cue and the two lines before it', () => {
    expect(deliveryNote(byText('What. Clip.'), script!, 0)).toBe(
      'a smart, sarcastic thirteen-year-old girl, dry and warm. cold, slow, each word its own sentence. ' +
        'Just before this, in the same scene: MILO said "I tried to laugh. It sounded like a lawn mower failing to start." Then MILO said "Heh. Okay. Funny story."'
    );
  });

  it('falls back to the cue alone, then to nothing', () => {
    const line = byText('What. Clip.');
    expect(deliveryNote(line, script!, 1)).toBe('cold, slow, each word its own sentence');
    expect(deliveryNote(line, script!, 2)).toBe('');
  });

  it('marks narration', async () => {
    const story = '---\ntitle: T\nnarrator:\n  voice: Charon\n  delivery: warm\n---\n\n*(hushed)* It was quiet.\n';
    const parsed = await parseStory(story, { path: 't.md' });
    const line = parsed.script!.chapters[0]!.scenes[0]!.segments[0] as Line;
    expect(deliveryNote(line, parsed.script!, 0)).toBe('warm. narrating. hushed');
  });
});
