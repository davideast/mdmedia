import { describe, expect, it } from 'bun:test';
import { parseStory } from '../../../src/story/index.js';
import type { TextModel } from '../../../src/story/index.js';
import { directStory } from '../../../src/story/direct/direct.js';
import { CAST_INSTRUCTION, REPAIR_INSTRUCTION, SCENE_INSTRUCTION } from '../../../src/story/direct/prompts.js';

const RAW = `The Bus

The bus pulled away. "Wait!" Maya shouted.

Dad laughed. "It left."

---

Ten minutes later, the next bus came.
`;

const PLAN = {
  title: 'The Bus',
  narrator: { voice: 'Charon', delivery: 'warm' },
  cast: { MAYA: { voice: 'Kore', delivery: 'quick, eleven' }, DAD: { voice: 'Puck', delivery: 'dry, amused' } },
  names: [],
  scenes: [
    { title: 'One', firstWords: 'The bus pulled away.', music: 'bouncy morning strings' },
    { title: 'Two', firstWords: 'Ten minutes later', music: 'gentle piano' },
  ],
};

const GOOD_ONE = `*(brisk)* The bus pulled away.

**MAYA** *(panicked)*: Wait!

*(wry)* Dad laughed.

**DAD** *(amused)*: It left.`;
const GOOD_TWO = `*(relieved)* Ten minutes later, the next bus came.`;

/** A scripted writer: answers by which instruction it was given and which scene the prompt holds. */
function writer(script: {
  cast?: (attempt: number) => string;
  scene?: (scene: 'one' | 'two') => string;
  repair?: (scene: 'one' | 'two', prompt: string, round: number) => string;
}): TextModel & { calls: Array<{ kind: string; prompt: string }> } {
  const calls: Array<{ kind: string; prompt: string }> = [];
  let castAttempts = 0;
  const rounds = new Map<string, number>();
  const which = (prompt: string) => (prompt.includes('Ten minutes later') && !prompt.includes('The bus pulled away') ? 'two' : 'one');
  return {
    model: 'fake-writer',
    calls,
    async generate({ system, prompt }) {
      if (system === CAST_INSTRUCTION) {
        calls.push({ kind: 'cast', prompt });
        return script.cast?.(castAttempts++) ?? JSON.stringify(PLAN);
      }
      const scene = which(prompt.split('The author\'s text for this scene:')[1] ?? prompt);
      if (system === REPAIR_INSTRUCTION) {
        calls.push({ kind: `repair-${scene}`, prompt });
        const round = (rounds.get(scene) ?? 0) + 1;
        rounds.set(scene, round);
        return script.repair?.(scene, prompt, round) ?? (scene === 'one' ? GOOD_ONE : GOOD_TWO);
      }
      if (system === SCENE_INSTRUCTION) {
        calls.push({ kind: `scene-${scene}`, prompt });
        return script.scene?.(scene) ?? (scene === 'one' ? GOOD_ONE : GOOD_TWO);
      }
      throw new Error('unexpected instruction');
    },
  };
}

describe('directStory', () => {
  it('writes a valid story file with every line cued, needing no repairs', async () => {
    const w = writer({});
    const { markdown, report, diagnostics } = await directStory(RAW, { writer: w });
    expect(diagnostics).toEqual([]);
    expect(report).toMatchObject({ scenes: 2, lines: 5, repairRounds: 0, remaining: [] });
    const { script } = await parseStory(markdown, { path: 'bus.md' });
    expect(script!.chapters[0]!.scenes.map((s) => [s.title, s.music])).toEqual([['One', 'bouncy morning strings'], ['Two', 'gentle piano']]);
    expect(w.calls.map((c) => c.kind).sort()).toEqual(['cast', 'scene-one', 'scene-two']);
  });

  it('gives each scene the end of the scene before it', async () => {
    const w = writer({});
    await directStory(RAW, { writer: w });
    expect(w.calls.find((c) => c.kind === 'scene-two')!.prompt).toContain('The scene before this one ends with');
    expect(w.calls.find((c) => c.kind === 'scene-one')!.prompt).toContain('This is the first scene.');
  });

  it('repairs an unknown speaker', async () => {
    const w = writer({ scene: (s) => (s === 'one' ? GOOD_ONE.replace('**DAD**', '**FATHER**') : GOOD_TWO) });
    const { report, diagnostics } = await directStory(RAW, { writer: w });
    expect(w.calls.filter((c) => c.kind === 'repair-one')).toHaveLength(1);
    expect(w.calls.find((c) => c.kind === 'repair-one')!.prompt).toContain('FATHER is not in the cast');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(report).toMatchObject({ repairRounds: 1, remaining: [] });
  });

  it('names a dropped sentence in the repair', async () => {
    const w = writer({ scene: (s) => (s === 'one' ? GOOD_ONE.replace('*(wry)* Dad laughed.\n\n', '') : GOOD_TWO) });
    const { report } = await directStory(RAW, { writer: w });
    expect(w.calls.find((c) => c.kind === 'repair-one')!.prompt).toContain('"dad laughed" are missing');
    expect(report.remaining).toEqual([]);
  });

  it('repairs a missing cue', async () => {
    const w = writer({ scene: (s) => (s === 'two' ? 'Ten minutes later, the next bus came.' : GOOD_ONE) });
    const { report } = await directStory(RAW, { writer: w });
    expect(w.calls.find((c) => c.kind === 'repair-two')!.prompt).toContain('has no cue');
    expect(report.remaining).toEqual([]);
  });

  it('stops after two repair rounds and reports what is left', async () => {
    const reworded = GOOD_TWO.replace('the next bus came', 'another bus arrived');
    const w = writer({ scene: (s) => (s === 'two' ? reworded : GOOD_ONE), repair: (s) => (s === 'two' ? reworded : GOOD_ONE) });
    const { report, markdown } = await directStory(RAW, { writer: w });
    expect(w.calls.filter((c) => c.kind === 'repair-two')).toHaveLength(2);
    expect(report.repairRounds).toBe(2);
    // "bus" still matches, so the rewording is two cuts and two additions.
    expect(new Set(report.remaining.map((p) => p.kind))).toEqual(new Set(['cut', 'unmarked-addition']));
    expect(markdown).toContain('another bus arrived');
  });

  it('replaces a told sentence with the line the cast pass chose, visibly', async () => {
    const raw = RAW.replace('Ten minutes later, the next bus came.', 'Ten minutes later, the next bus came. A kid at the back was arguing that buses are boats.');
    const two = `*(relieved)* Ten minutes later, the next bus came. A kid at the back was arguing that buses are boats.`;
    const plan = {
      ...PLAN,
      cast: { ...PLAN.cast, KID: { voice: 'Fenrir', delivery: 'loud kid' } },
      dramatize: [{ sentence: 'A kid at the back was arguing that buses are boats.', speaker: 'KID', cue: 'indignant, far off', line: 'Buses are TOO boats!' }],
    };
    const w = writer({ cast: () => JSON.stringify(plan), scene: (s) => (s === 'two' ? two : GOOD_ONE) });
    const { report, markdown } = await directStory(raw, { writer: w });
    expect(report.remaining).toEqual([]);
    expect(report.additions).toEqual(['Buses are TOO boats!']);
    expect(report.replaced).toEqual(['A kid at the back was arguing that buses are boats.']);
    expect(markdown).toContain('*(relieved)* Ten minutes later, the next bus came.\n\n<!-- replaced: "A kid at the back was arguing that buses are boats." -->\n\n<!-- director: added -->\n\n**KID** *(indignant, far off)*: Buses are TOO boats!');
  });

  it('sends back a dramatized line that explains itself instead of landing', async () => {
    const sentence = 'A kid at the back was arguing that buses are boats.';
    const raw = RAW.replace('Ten minutes later, the next bus came.', `Ten minutes later, the next bus came. ${sentence}`);
    const cast = { ...PLAN.cast, KID: { voice: 'Fenrir', delivery: 'loud kid' } };
    const wordy = { ...PLAN, cast, dramatize: [{ sentence, speaker: 'KID', cue: 'indignant', line: 'Buses float on wheels, so they are basically TOTALLY boats!' }] };
    const punchy = { ...wordy, dramatize: [{ ...wordy.dramatize[0]!, line: 'Buses are TOO boats!' }] };
    const w = writer({ cast: (n) => JSON.stringify(n === 0 ? wordy : punchy), scene: (s) => (s === 'two' ? `*(relieved)* Ten minutes later, the next bus came. ${sentence}` : GOOD_ONE) });
    const { report } = await directStory(raw, { writer: w });
    expect(w.calls[1]!.prompt).toContain('a dramatized line is a punchline of at most 8 words');
    expect(report.additions).toEqual(['Buses are TOO boats!']);
  });

  it('rejects a dramatization whose sentence is not in the story', async () => {
    const plan = { ...PLAN, dramatize: [{ sentence: 'Nobody said this.', speaker: 'MAYA', cue: 'x', line: 'y' }] };
    await expect(directStory(RAW, { writer: writer({ cast: () => JSON.stringify(plan) }) })).rejects.toThrow(/not in the story word for word/);
  });

  it('retries a cast with a voice that does not exist, then fails on a second bad answer', async () => {
    const bad = JSON.stringify({ ...PLAN, cast: { ...PLAN.cast, MAYA: { voice: 'Bob', delivery: 'x' } } });
    const recovers = writer({ cast: (n) => (n === 0 ? bad : JSON.stringify(PLAN)) });
    await directStory(RAW, { writer: recovers });
    expect(recovers.calls.filter((c) => c.kind === 'cast')).toHaveLength(2);
    expect(recovers.calls[1]!.prompt).toContain('"Bob" is not one of the Gemini voices');

    await expect(directStory(RAW, { writer: writer({ cast: () => bad }) })).rejects.toThrow(/cast pass failed/);
  });
});
