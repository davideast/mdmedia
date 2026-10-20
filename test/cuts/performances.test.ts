import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { loadCutSource, resolveCut, type CheckFile, type ResolvedSource, type Timeline } from '../../src/cut/index';

/**
 * The performance annotations on the calibration cuts (see docs/cut-check.md):
 * Big Hal Take 5, which the owner heard as broken ("…by me! PERSONALLY!" as
 * two performances, the Wheels setup and payoff split with a shouted reveal),
 * Takes 6 and 7, and Night Wagon Take 9, whose Rick lines are one take. The
 * splitting rule separates them on the cut alone; the stored checks hold the
 * measured flags.
 */

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../docs/cuts/${name}.cut.json`, import.meta.url), 'utf8'));

/** big-hal-4ab-t2 is big-hal-4a-t2 (10.01 s, probed) extended: its seam is at 10.01 s. */
const LENGTHS: Record<string, number> = { 'big-hal-4a-t2': 10.01 };

async function timeline(name: string, lengths = LENGTHS): Promise<Timeline> {
  const cut = await loadCutSource(read(name), async (base) => read(base), { name });
  if (!cut.ok) throw new Error(cut.errors.map((e) => e.message).join('\n'));
  const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? lengths[src.name] : undefined);
  const r = resolveCut(cut.value, { mediaLength });
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.value;
}

function splits(t: Timeline): Record<string, string[]> {
  return Object.fromEntries(t.performances.map((p) => [p.id, p.splits.map((s) => s.code)]));
}

function check(name: string): CheckFile | null {
  const file = new URL(`../../docs/cuts/${name}.check.json`, import.meta.url);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CheckFile) : null;
}

function flags(file: CheckFile): Record<string, string[]> {
  return Object.fromEntries(file.measured.performances.map((p) => [p.id, p.flags.map((f) => f.code)]));
}

describe('the splitting rule on the calibration cuts', () => {
  it("breaks in Big Hal Take 5 exactly where the owner heard two performances", async () => {
    expect(splits(await timeline('big-hal-take5'))).toEqual({
      opening: [],
      inspection: ['separate-generations'],
      list: [],
      wheels_joke: ['separate-generations'],
    });
  });

  it('holds for the punchline in Takes 6 and 7, and for every sentence of Take 7', async () => {
    expect(splits(await timeline('big-hal-take6'))).toEqual({ opening: [], inspection: ['separate-generations'], list: [], wheels_joke: [] });
    expect(splits(await timeline('big-hal-take7'))).toEqual({
      opening: [], no_extras: [], kept_simple: [], the_price: [], inspection: [], the_guarantee: [], wheels_joke: [],
    });
  });

  it("holds for Rick's lines in Night Wagon Take 9, one take across Buddy's", async () => {
    const t = await timeline('night-wagon-take9');
    expect(splits(t)).toEqual({ rick_argument: [] });
    expect(t.performances[0].generations.map((g) => [g.key, g.lines])).toEqual([['take:nw7-rick-lines-t1', ['getaway', 'jump', 'boost', 'notime']]]);
  });

  it("places Take 4's opening before its extend seam, and says it can't without the original's length", async () => {
    const opening = (await timeline('big-hal-take5')).performances[0];
    expect(opening.generations.map((g) => [g.key, g.part, g.seam])).toEqual([['take:big-hal-4a-t2', 'original', 10.01]]);
    const unknown = (await timeline('big-hal-take5', {})).performances[0];
    expect(unknown.splits.map((s) => s.code)).toEqual(['unknown-seam', 'unknown-seam', 'unknown-seam', 'unknown-seam']);
  });
});

describe('the stored checks on the calibration cuts', () => {
  it("flag Take 5's two broken performances, and none of the good ones", () => {
    const t5 = check('big-hal-take5');
    if (!t5) return;
    expect(flags(t5)).toEqual({
      opening: [],
      inspection: ['splitting-rule', 'loudness-jump', 'rate-jump', 'room-tone-jump'],
      list: [],
      wheels_joke: ['splitting-rule', 'loudness-jump', 'pitch-jump', 'long-pause', 'room-tone-jump'],
    });
    const t6 = check('big-hal-take6');
    if (t6) expect(flags(t6).wheels_joke).toEqual([]);
    const nw9 = check('night-wagon-take9');
    if (nw9) expect(flags(nw9)).toEqual({ rick_argument: [] });
    const t7 = check('big-hal-take7');
    if (t7) expect(Object.values(flags(t7)).flat()).toEqual([]);
  });
});
