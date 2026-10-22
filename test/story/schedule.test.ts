import { describe, expect, it } from 'bun:test';
import { parseStory, scheduleStory } from '../../src/story/index.js';
import type { Line, StoryScript } from '../../src/story/index.js';

const md = `---
title: Timing
gap: 400ms
narrator:
  voice: Charon
cast:
  MAYA:
    voice: Kore
---

### One

*(calm)* The bus left.

**MAYA** *(panicked)*: Wait!

\`\`\`pause
1s
\`\`\`

\`\`\`pause
500ms
\`\`\`

**MAYA** *(quiet)*: Never mind.

### Two

\`\`\`pause
0ms
\`\`\`

*(calm)* Later.
`;

describe('scheduleStory', async () => {
  const script = (await parseStory(md, { path: 't.md' })).script as StoryScript;
  const lines = script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const durations = new Map(lines.map((l, i) => [l.id, 1000 + i * 100]));
  const renders = new Map(lines.map((l) => [l.id, `line:${l.id}`]));
  const timeline = scheduleStory(script, durations, renders);

  it('places lines with the gap, or the pauses written instead of it', () => {
    expect(timeline.lines.map((l) => [l.text, l.startMs, l.endMs])).toEqual([
      ['The bus left.', 0, 1000],
      ['Wait!', 1400, 2500],
      ['Never mind.', 4000, 5200],
      ['Later.', 5200, 6500],
    ]);
    expect(timeline.durationMs).toBe(6500);
  });

  it('never overlaps clips and records render keys', () => {
    for (let i = 1; i < timeline.lines.length; i++) expect(timeline.lines[i]!.startMs).toBeGreaterThanOrEqual(timeline.lines[i - 1]!.endMs);
    expect(timeline.lines[0]!.render).toBe(`line:${lines[0]!.id}`);
  });

  it('gives scenes and chapters their spans', () => {
    expect(timeline.scenes.map((s) => [s.title, s.startMs, s.endMs])).toEqual([
      ['One', 0, 5200],
      ['Two', 5200, 6500],
    ]);
    expect(timeline.chapters).toEqual([{ id: '00', startMs: 0, endMs: 6500 }]);
  });

  it('throws when a line has no duration', () => {
    expect(() => scheduleStory(script, new Map(), renders)).toThrow(/No duration/);
  });
});
