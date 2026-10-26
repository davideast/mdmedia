import { describe, expect, it } from 'bun:test';
import { adaptStory } from '../../../src/story/adapt/adapt.js';
import { assembleComic, sceneLineIds, type SceneAdaptation } from '../../../src/story/adapt/assemble.js';
import { adaptationProblems } from '../../../src/story/adapt/fidelity.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { parseStory } from '../../../src/story/index.js';
import type { Line, TextModel } from '../../../src/story/index.js';

const STORY = `---
title: Mirror
narrator:
  brief: A warm storyteller from Edinburgh.
cast:
  WREN:
    brief: Wren, eleven, from Peckham.
    look: a girl with a frizzy copper bob and a yellow raincoat
  ODILE:
    brief: Odile, eighty-one, from Whitby.
    look: an old woman with a grey bun and a mustard cardigan
  VOICE:
    brief: A voice from the mirror.
---

# Mirror

### Shop

*(dry)* The shop sold mirrors. Most of them were old.

**ODILE** *(curt)*: Wren Pickett. Upstairs.

*(eerie)* Her reflection blinked a beat late.

**WREN** *(rattled)*: I'm going mad. That's fine.

### Night

*(hushed)* At midnight, the glass spoke.

**VOICE** *(sweet)*: Hello, Wren.

**WREN** *(whispering)*: Who's there?
`;

const SHOP: SceneAdaptation = {
  setting: 'a cluttered antique shop full of mirrors',
  staging: 'Odile behind the counter on the right; Wren in front of it on the left.',
  rules: 'Wren stays on the left of the frame and Odile on the right.',
  pages: [
    {
      rows: [1, 2],
      panels: [
        { shot: 'Wide shot of the shop', left: ['WREN'], right: ['ODILE'], zone: 'top', acting: 'Odile is fed up.', items: [{ line: 'L1', text: 'The shop sold mirrors.' }, { line: 'L2' }] },
        { shot: 'Extreme close-up: only Wren\'s face, filling the frame from hair to chin', center: ['WREN'], zone: 'top', acting: 'Wren stares at the mirror.', items: [{ line: 'L3' }] },
        { shot: 'Same face', center: ['WREN'], zone: 'top', acting: 'Change only her expression: rattled.', continues: true, items: [{ line: 'L4' }] },
      ],
    },
  ],
};

const NIGHT_MISSING: SceneAdaptation = {
  setting: 'the upstairs landing at midnight, moonlight on a tall mirror',
  pages: [
    {
      rows: [1, 1, 1],
      panels: [
        { shot: 'Wide shot of the landing', center: ['WREN'], zone: 'top', acting: 'Wren creeps out.', items: [{ line: 'L1' }] },
        { shot: 'The mirror glows', center: ['WREN'], zone: 'bottom', acting: 'The glass shimmers.', items: [{ line: 'L2' }] },
        { shot: 'Close on Wren', center: ['WREN'], zone: 'top', acting: 'Wren is scared.', items: [] },
      ],
    },
  ],
};
const NIGHT_FIXED: SceneAdaptation = { ...NIGHT_MISSING, pages: [{ ...NIGHT_MISSING.pages[0]!, panels: NIGHT_MISSING.pages[0]!.panels.map((p, i) => (i === 2 ? { ...p, items: [{ line: 'L3', mark: 'small' as const }] } : p)) }] };

function writer(replies: (prompt: string, system: string) => SceneAdaptation | string): TextModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    model: 'fake-writer',
    prompts,
    async generate({ prompt, system }) {
      prompts.push(prompt);
      const reply = replies(prompt, system);
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
}

const script = async () => (await parseStory(STORY, { path: 'mirror.md' })).script!;
const linesOf = async (title: string) => sceneLineIds((await script()).chapters[0]!.scenes.find((s) => s.title === title)!.segments.filter((s): s is Line => s.kind === 'line'));

describe('assembleComic', () => {
  it('writes a comic script that parses: layouts, cues, a continue chain, setting and staging', async () => {
    const lines = await linesOf('Shop');
    const { markdown } = assembleComic({ title: 'Mirror', story: 'mirror.md', style: 'flat' }, [{ adaptation: SHOP, lines }]);
    const { comic, diagnostics } = await parseComic(markdown, { path: 'c.md', cast: (await script()).cast });
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = comic!.pages[0]!;
    expect(page.layout).toEqual([[1], [1, 1]]);
    expect(page.panels[2]!.continues).toBe('1.2');
    expect(page.panels[0]!.staging).toContain('behind the counter');
    expect(page.panels[0]!.items[0]).toMatchObject({ kind: 'caption', cue: 'dry', text: 'The shop sold mirrors.' });
    expect(page.panels[0]!.items[1]).toMatchObject({ kind: 'balloon', who: 'ODILE', cue: 'curt' });
    expect(page.panels[0]!.positions).toEqual({ WREN: 'left', ODILE: 'right' });
  });
});

describe('adaptationProblems', () => {
  it('passes a faithful scene', async () => {
    expect(adaptationProblems(SHOP, await linesOf('Shop'), (await script()).cast)).toEqual([]);
  });

  it('names dropped dialogue, reworded text, story order, page shapes, undrawable cast and a stray continue', async () => {
    const lines = await linesOf('Shop');
    const bad: SceneAdaptation = {
      setting: 'shop',
      pages: [
        {
          rows: [2],
          panels: [
            { shot: 'A', center: ['VOICE'], zone: 'top', acting: 'x', continues: true, items: [{ line: 'L3' }, { line: 'L1', text: 'The shop sold old mirrors.' }] },
            { shot: 'B', zone: 'top', acting: 'y', items: [{ line: 'L4', text: "That's fine." }] },
          ],
        },
      ],
    };
    const problems = adaptationProblems(bad, lines, (await script()).cast).join('\n');
    expect(problems).toContain('has 2 panels');
    expect(problems).toContain('places VOICE, who is not a cast member with a look');
    expect(problems).toContain('first panel on its page');
    expect(problems).toContain('not an exact part of the line');
    expect(problems).toContain("ODILE's line L2 must appear in balloons");
    expect(problems).toContain('missing: "i\'m going mad"');
  });
});

describe('adaptStory', () => {
  it('adapts every scene, marks undrawn speakers off, repairs dropped dialogue, and reports', async () => {
    const w = writer((prompt) => (prompt.includes('Scene: Shop') ? SHOP : prompt.includes('Problems to fix') ? NIGHT_FIXED : NIGHT_MISSING));
    const { markdown, report } = await adaptStory(STORY, { writer: w, story: 'mirror.md' });
    expect(report!.repairRounds).toBe(1);
    expect(report!.remaining).toEqual([]);
    expect(report).toMatchObject({ scenes: 2, pages: 2, panels: 6, balloons: 4, captions: 3, narration: { lines: 3, captioned: 3 } });
    expect(markdown).toContain('**VOICE** *(sweet)* [off]: Hello, Wren.');
    expect(markdown).toContain('**WREN** *(whispering)* [small]: Who\'s there?');
    expect(markdown).toContain('## Page 2');
    // The second scene clears the first scene's staging and rules.
    expect(markdown).toContain('staging: ""');
    const { diagnostics } = await parseComic(markdown!, { path: 'c.md', cast: (await script()).cast });
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(w.prompts.find((p) => p.includes('Problems to fix'))).toContain("WREN's line L3 must appear in balloons");
  });

  it('gives the adapter the drawable cast, the numbered lines and the end of the scene before', async () => {
    const w = writer((prompt) => (prompt.includes('Scene: Shop') ? SHOP : NIGHT_FIXED));
    await adaptStory(STORY, { writer: w, story: 'mirror.md' });
    const night = w.prompts.find((p) => p.includes('Scene: Night'))!;
    expect(night).toContain('- WREN: a girl with a frizzy copper bob');
    expect(night).toContain('Voices nobody sees: VOICE, NARRATOR.');
    expect(night).toContain('L2 VOICE (sweet): Hello, Wren.');
    expect(night).toContain("The scene before ends:\nODILE: Wren Pickett. Upstairs.\nnarration: Her reflection blinked a beat late.\nWREN: I'm going mad. That's fine.");
  });

  it('adapts one scene with --scene, titled after it', async () => {
    const w = writer(() => SHOP);
    const { markdown, report } = await adaptStory(STORY, { writer: w, story: 'mirror.md', scene: 'shop', style: 'watercolor' });
    expect(report!.scenes).toBe(1);
    expect(markdown).toContain('title: Mirror — Shop');
    expect(markdown).toContain('style: watercolor');
  });

  it('reports a reply that is not JSON after the repair rounds run out', async () => {
    const { report } = await adaptStory(STORY, { writer: writer((p) => (p.includes('Scene: Shop') ? SHOP : 'not json')), story: 'mirror.md' });
    expect(report!.repairRounds).toBe(2);
    expect(report!.remaining[0]).toMatchObject({ scene: 'Night' });
    expect(report!.remaining[0]!.problem).toContain('not valid JSON');
  });
});
