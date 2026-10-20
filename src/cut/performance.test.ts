import { describe, expect, it } from 'bun:test';
import { CUT_FORMAT, extendCut, parseCut, parseCutExtension, resolveCut, type CutFile, type ResolvedSource, type Timeline } from './index.js';

/**
 * A pitchman's commercial in three takes: an extended opening (the take it
 * continued is 10 s long), a medium shot and a one-word insert.
 */
function cut(patch: Partial<CutFile> = {}): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'Lot', fps: 24, width: 1280, height: 720 },
    media: { root: '/m' },
    segments: [
      { id: 'open', src: 'take:open_ab', in: 0, out: 14 },
      { id: 'mid', src: 'take:mid', in: 0, out: 3 },
      { id: 'pat', src: 'take:pat', in: 0, out: 1.5 },
    ],
    lines: [
      { id: 'howdy', speaker: 'Hal', text: 'Howdy folks!', segment: 'open', until: 'deal' },
      { id: 'deal', speaker: 'Hal', text: 'No money down!', segment: 'open', at: 'open+6', until: 'open+9.5' },
      { id: 'late', speaker: 'Hal', text: 'Ninety-nine a month!', segment: 'open', at: 'open+11' },
      { id: 'every', speaker: 'Hal', text: 'Hand-inspected by me!', segment: 'mid', delivery: 'proud and steady' },
      { id: 'pers', speaker: 'Hal', text: 'PERSONALLY!', src: 'take:personally', in: 0.5, out: 1.5, at: 'pat', layer: 'pat' },
      { id: 'wife', speaker: 'Wife', text: 'Oh, Hal.', segment: 'pat', at: 'pat+1' },
    ],
    sources: {
      'take:open_ab': { step: 'extend', extendedFrom: 'take:open_a' },
    },
    ...patch,
  };
}

function resolved(c: CutFile, lengths: Record<string, number> = {}): Timeline {
  const mediaLength = (src: ResolvedSource): number | undefined => (src.kind === 'take' ? lengths[src.name] : undefined);
  const result = resolveCut(c, { mediaLength });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

function errorsOf(c: CutFile): Array<{ code: string; message: string }> {
  const result = resolveCut(c);
  if (result.ok) throw new Error('expected errors');
  return result.errors.map((e) => ({ code: e.code, message: e.message }));
}

describe('performances in the format', () => {
  it('parses a cut-level list and a line-level delivery note, and changes nothing for a cut without them', () => {
    const json = {
      ...cut(),
      performances: [{ id: 'inspection', lines: ['every', 'pers'], intent: 'one sentence', delivery: 'one breath', thresholds: { pause: 0.4 } }],
      check: { thresholds: { loudness: 3 } },
    };
    const parsed = parseCut(JSON.parse(JSON.stringify(json)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.performances).toEqual([{ id: 'inspection', lines: ['every', 'pers'], intent: 'one sentence', delivery: 'one breath', thresholds: { pause: 0.4 } }]);
    expect(parsed.value.check).toEqual({ thresholds: { loudness: 3 } });
    expect(parsed.value.lines?.find((l) => l.id === 'every')?.delivery).toBe('proud and steady');

    const timeline = resolved(parsed.value);
    expect(timeline.performances.map((p) => [p.id, p.lines, p.intent, p.delivery, p.label])).toEqual([['inspection', ['every', 'pers'], 'one sentence', 'one breath', 'one sentence']]);
    expect(timeline.performances[0].thresholds).toEqual({ pause: 0.4 });
    expect(timeline.check).toEqual({ thresholds: { loudness: 3 } });
    expect(timeline.lines.find((l) => l.id === 'every')?.delivery).toBe('proud and steady');

    const plain = resolved(cut());
    expect(plain.performances).toEqual([]);
    expect(plain.check).toEqual({ thresholds: {} });
    expect(plain.lines.find((l) => l.id === 'howdy')?.delivery).toBeNull();
  });

  it('refuses a performance with no lines, a threshold that is not one, or one that is not above 0', () => {
    const bad = (performances: unknown, check?: unknown): string[] => {
      const result = parseCut({ ...cut(), performances, ...(check ? { check } : {}) });
      return result.ok ? [] : result.errors.map((e) => e.message);
    };
    expect(bad([{ id: 'p', lines: [] }])).toEqual(['performances[0].lines: expected at least one line id']);
    expect(bad([{ id: 'p', lines: ['every', 3] }])).toEqual(['performances[0].lines: expected line ids']);
    expect(bad([{ id: 'p' }])).toEqual(['performances[0].lines: is required']);
    expect(bad([], { thresholds: { volume: 2 } })).toEqual(['check.thresholds.volume: isn\'t a threshold; use loudness, pitch, rate, pause, roomTone, word']);
    expect(bad([], { thresholds: { pause: 0 } })).toEqual(['check.thresholds.pause: expected a number above 0 (got 0)']);
  });
});

describe('resolving performances', () => {
  it('reports a line that is in no line list, in two performances, or twice in one', () => {
    expect(errorsOf(cut({ performances: [{ id: 'p', lines: ['every', 'nope'] }] }))).toEqual([{ code: 'unknown-line', message: 'p: no line is called "nope"' }]);
    expect(errorsOf(cut({ performances: [{ id: 'p', lines: ['every', 'pers'] }, { id: 'q', lines: ['pers'] }] }))).toEqual([
      { code: 'shared-line', message: 'The line "pers" is in two performances, p and q' },
    ]);
    expect(errorsOf(cut({ performances: [{ id: 'p', lines: ['every', 'every'] }] }))).toEqual([{ code: 'shared-line', message: 'p lists the line "every" twice' }]);
  });

  it('keeps its id unique among every item and wants its lines in spoken order', () => {
    expect(errorsOf(cut({ performances: [{ id: 'mid', lines: ['every'] }] }))).toEqual([{ code: 'duplicate-id', message: 'The id "mid" is used more than once' }]);
    expect(errorsOf(cut({ performances: [{ id: 'p', lines: ['every'] }, { id: 'p', lines: ['pers'] }] }))).toEqual([{ code: 'duplicate-id', message: 'The id "p" is used more than once' }]);
    expect(errorsOf(cut({ performances: [{ id: 'bad-id', lines: ['every'] }] }))[0].code).toBe('bad-id');
    expect(errorsOf(cut({ performances: [{ id: 'p', lines: ['pers', 'every'] }] }))).toEqual([
      { code: 'bad-value', message: 'p: list its lines in the order they are spoken (pers, every)' },
    ]);
  });

  it('spans its lines on the timeline and names its speakers', () => {
    const p = resolved(cut({ performances: [{ id: 'p', lines: ['every', 'pers'] }] })).performances[0];
    expect([p.start, p.end, p.speakers]).toEqual([14, 18, ['Hal']]);
  });
});

describe('the splitting rule', () => {
  it('flags lines from different sources as separate generations', () => {
    const p = resolved(cut({ performances: [{ id: 'inspection', lines: ['every', 'pers'] }] })).performances[0];
    expect(p.generations.map((g) => [g.key, g.part, g.lines])).toEqual([
      ['take:mid', 'whole', ['every']],
      ['take:personally', 'whole', ['pers']],
    ]);
    expect(p.splits.map((s) => [s.code, s.lines])).toEqual([['separate-generations', ['every', 'pers']]]);
    expect(p.splits[0].message).toBe(
      'its lines come from 2 generations (every from take:mid; pers from take:personally); a sentence, and a setup with its payoff, should be one',
    );
  });

  it("places an extended take's lines either side of its seam, at the length of the take it continued", () => {
    const perf = { id: 'opening', lines: ['howdy', 'deal'] };
    // Both lines end before 10 s: the original generation, whole.
    const before = resolved(cut({ performances: [perf] }), { open_a: 10 }).performances[0];
    expect(before.generations.map((g) => [g.key, g.part, g.seam, g.lines])).toEqual([['take:open_a', 'original', 10, ['howdy', 'deal']]]);
    expect(before.splits).toEqual([]);

    // "late" is after the seam: the extension, a separate generation.
    const across = resolved(cut({ performances: [{ id: 'opening', lines: ['howdy', 'deal', 'late'] }] }), { open_a: 10 }).performances[0];
    expect(across.generations.map((g) => [g.key, g.part])).toEqual([['take:open_a', 'original'], ['take:open_ab@10', 'extension']]);
    expect(across.splits.map((s) => s.code)).toEqual(['separate-generations']);
    expect(across.splits[0].message).toContain('late from the extension of take:open_ab');

    // A line whose speech runs over the seam is split by it.
    const straddle = resolved(cut({ performances: [{ id: 'opening', lines: ['deal'] }] }), { open_a: 7 }).performances[0];
    expect(straddle.splits.map((s) => [s.code, s.lines])).toEqual([['across-extend', ['deal']]]);
    expect(straddle.splits[0].message).toBe('"No money down!" runs across the seam of the extended take take:open_ab (7 s): its end is a separate generation');
  });

  it("can't place the seam without the original's length, and says so", () => {
    const p = resolved(cut({ performances: [{ id: 'opening', lines: ['howdy', 'deal'] }] })).performances[0];
    expect(p.splits.map((s) => [s.code, s.lines])).toEqual([['unknown-seam', ['howdy']], ['unknown-seam', ['deal']]]);
    expect(p.generations.map((g) => [g.key, g.part])).toEqual([['take:open_ab', 'unknown']]);
  });

  it('uses word timings, in the source clock, when a line has them', () => {
    // Speech from 9.2 to 9.8 s of the source: before a 10 s seam, though the line runs on to 14 s.
    const lines = cut().lines?.map((l) => (l.id === 'late' ? { ...l, at: 'open+9', words: [{ text: 'Ninety-nine', start: 9.2, end: 9.5 }, { text: 'a month!', start: 9.5, end: 9.8 }] } : l));
    const p = resolved(cut({ lines, performances: [{ id: 'p', lines: ['late'] }] }), { open_a: 10 }).performances[0];
    expect(p.splits).toEqual([]);
    expect(p.generations[0].key).toBe('take:open_a');
  });

  it('flags a performance said by more than one speaker', () => {
    const p = resolved(cut({ performances: [{ id: 'p', lines: ['pers', 'wife'] }] })).performances[0];
    expect(p.splits.map((s) => s.code)).toEqual(['separate-generations', 'mixed-speakers']);
    expect(p.splits[1].message).toBe("its lines are said by Hal and Wife; a performance is one speaker's delivery");
  });
});

describe('performances in a variant', () => {
  it('replaces a performance by id, adds new ones, removes by id and merges the thresholds', () => {
    const base = cut({ performances: [{ id: 'inspection', lines: ['every', 'pers'] }, { id: 'opening', lines: ['howdy'] }], check: { thresholds: { pause: 0.5, pitch: 8 } } });
    const ext = parseCutExtension({
      format: CUT_FORMAT, extends: 'lot',
      performances: [{ id: 'inspection', lines: ['every'], intent: 'just the line' }, { id: 'wife_line', lines: ['wife'] }],
      check: { thresholds: { pitch: 6 } },
      remove: ['opening'],
    });
    expect(ext.ok).toBe(true);
    if (!ext.ok) return;
    const merged = extendCut(base, ext.value);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.performances).toEqual([{ id: 'inspection', lines: ['every'], intent: 'just the line' }, { id: 'wife_line', lines: ['wife'] }]);
    expect(merged.value.check).toEqual({ thresholds: { pause: 0.5, pitch: 6 } });
  });

  it("reports a base's performance that names a line the variant removed", () => {
    const base = cut({ performances: [{ id: 'inspection', lines: ['every', 'pers'] }] });
    const ext = parseCutExtension({ format: CUT_FORMAT, extends: 'lot', remove: ['pers'] });
    if (!ext.ok) throw new Error('bad extension');
    const merged = extendCut(base, ext.value);
    if (!merged.ok) throw new Error('bad merge');
    expect(errorsOf(merged.value)).toEqual([{ code: 'unknown-line', message: 'inspection: no line is called "pers"' }]);
  });
});

describe('voice swaps', () => {
  /** "Hand-inspected by me!" and "PERSONALLY!" from one take, the second half played from its voice swap. */
  const swapped = (sources: CutFile['sources']) => cut({
    segments: [
      { id: 'mid', src: 'take:mid', in: 0, out: 3 },
      { id: 'mid_swap', src: 'voiceswap/mid-hal.mp4', in: 3, out: 5 },
    ],
    lines: [
      { id: 'every', speaker: 'Hal', text: 'Hand-inspected by me!', segment: 'mid' },
      { id: 'pers', speaker: 'Hal', text: 'PERSONALLY!', segment: 'mid_swap' },
    ],
    sources,
    performances: [{ id: 'inspection', lines: ['every', 'pers'] }],
  });

  it('are the same generation as the take they were swapped from, so the splitting rule holds', () => {
    const t = resolved(swapped({ 'voiceswap/mid-hal.mp4': { step: 'swap', swappedFrom: 'take:mid', voice: 'big-hal@1' } }));
    expect(t.performances[0].splits).toEqual([]);
    expect(t.sources['voiceswap/mid-hal.mp4']).toMatchObject({ step: 'swap', swappedFrom: { kind: 'take', ref: 'take:mid' }, voice: 'big-hal@1' });
  });

  it('without that provenance, are another file: two generations', () => {
    const t = resolved(swapped({}));
    expect(t.performances[0].splits.map((s) => s.code)).toEqual(['separate-generations']);
  });
});
