import { describe, expect, it } from 'bun:test';
import {
  CHECK_FORMAT,
  DEFAULT_THRESHOLDS,
  checkAnswers,
  clipRange,
  describeDelivery,
  fingerprintChange,
  fingerprintMaterial,
  listeningFacts,
  listeningQuestions,
  measureCut,
  parseCheckFile,
  readVerdict,
  serializeCheckFile,
  thresholdsFor,
  type CheckFile,
  type CutFile,
  type Timeline,
} from './index.js';
import { CUT_FORMAT, resolveCut } from './index.js';

const SR = 48_000;

/** Deterministic white noise at an RMS level in dBFS. */
function noise(seconds: number, db: number, seed = 7): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const amp = 10 ** (db / 20) * Math.sqrt(3);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    out[i] = amp * (2 * (s / 4294967296) - 1);
  }
  return out;
}

/** A voice-like tone (a fundamental and harmonics) added into `into` from `start` to `end` seconds. */
function voice(into: Float32Array, start: number, end: number, hz: number, amplitude: number): void {
  const amps = [0.6, 0.5, 0.3, 0.2, 0.1];
  for (let i = Math.round(start * SR); i < Math.round(end * SR); i++) {
    let v = 0;
    for (const [k, a] of amps.entries()) v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / SR);
    into[i] += amplitude * v;
  }
}

/** Four words spread over a stretch, as a words file would give them. */
function words(text: string, start: number, end: number): Array<{ text: string; start: number; end: number }> {
  const ws = text.split(' ');
  const step = (end - start) / ws.length;
  return ws.map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step - 0.02 }));
}

/** Two shots, a cut at 2 s; a line in each, timed by their words, as one performance. */
function timeline(patch: Partial<CutFile> = {}): Timeline {
  const cut: CutFile = {
    format: CUT_FORMAT,
    meta: { title: 'Lot', fps: 24, width: 640, height: 360 },
    media: { root: '/m' },
    segments: [
      { id: 'a', src: 'take:a', in: 0, out: 2 },
      { id: 'b', src: 'take:b', in: 0, out: 2.5 },
    ],
    lines: [
      { id: 'setup', speaker: 'Hal', text: 'This one even comes with', segment: 'a', words: words('This one even comes with', 0.3, 1.6) },
      { id: 'payoff', speaker: 'Hal', text: 'wheels and a great big bow', segment: 'b', words: words('wheels and a great big bow', 0.4, 1.9) },
    ],
    performances: [{ id: 'joke', lines: ['setup', 'payoff'], intent: 'setup and punchline', delivery: 'an ordinary selling point, no pause before "wheels"' }],
    ...patch,
  };
  const r = resolveCut(cut);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.value;
}

/** The stem: room tone in each shot, a voice for each line. */
function stem(options: { roomB?: number; hzB?: number; ampB?: number } = {}): { audio: { samples: Float32Array; sampleRate: number }; start: number } {
  const samples = new Float32Array(Math.round(4.5 * SR));
  samples.set(noise(2, -60), 0);
  samples.set(noise(2.5, options.roomB ?? -60, 11), 2 * SR);
  voice(samples, 0.3, 1.6, 130, 0.05);
  voice(samples, 2.4, 3.9, options.hzB ?? 130, options.ampB ?? 0.05);
  return { audio: { samples, sampleRate: SR }, start: 0 };
}

describe('measuring a cut', () => {
  it('measures every line: loudness, pitch, rate, word levels', () => {
    const m = measureCut(timeline(), stem());
    expect(m.method).toBe('dialogue-stem@1');
    expect(m.range).toEqual({ from: 0, to: 4.5 });
    const [setup, payoff] = m.lines;
    expect(setup.speech).toEqual({ start: 0.3, end: 1.58 });
    expect(setup.timedBy).toBe('words');
    expect(setup.pitch?.median).toBeCloseTo(130, -0.5);
    expect(setup.pitch?.range).toBeLessThan(0.5);
    expect(setup.rate?.words).toBeCloseTo(5 / 1.28, 2);
    expect(setup.syllables).toBe(7);
    expect(Math.abs((setup.loudness ?? 0) - (payoff.loudness ?? 0))).toBeLessThan(0.5);
    expect(setup.wordLevels.map((w) => w.text)).toEqual(['This', 'one', 'even', 'comes', 'with']);
  });

  it('flags nothing across a boundary that carries on at the same level, pitch, pace and room tone', () => {
    const m = measureCut(timeline(), stem());
    const p = m.performances[0];
    expect(p.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(p.boundaries).toHaveLength(1);
    const b = p.boundaries[0];
    expect([b.from, b.to, b.between]).toEqual(['setup', 'payoff', []]);
    expect(b.pause).toBeCloseTo(0.82, 3);
    expect(Math.abs(b.loudness ?? 9)).toBeLessThan(0.5);
    expect(Math.abs(b.pitch ?? 9)).toBeLessThan(0.3);
    expect(p.cuts.map((c) => [c.from, c.to, c.at])).toEqual([['a', 'b', 2]]);
    expect(Math.abs(p.cuts[0].change ?? 9)).toBeLessThan(1);
    expect(p.flags.map((f) => f.code)).toEqual(['splitting-rule', 'long-pause']);
  });

  it('flags a shouted reveal after a pause, over a change of room tone', () => {
    const m = measureCut(timeline(), stem({ hzB: 300, ampB: 0.3, roomB: -45 }));
    const p = m.performances[0];
    const b = p.boundaries[0];
    expect(b.loudness).toBeGreaterThan(14);
    expect(b.pitch).toBeCloseTo(12 * Math.log2(300 / 130), 0);
    expect(p.cuts[0].before).toBeCloseTo(-60, 0);
    expect(p.cuts[0].after).toBeCloseTo(-45, 0);
    expect(p.flags.map((f) => f.code)).toEqual(['splitting-rule', 'loudness-jump', 'pitch-jump', 'long-pause', 'room-tone-jump']);
    expect(p.flags[2].message).toBe(`"one even comes with" → "wheels and a great": pitch jumps up ${b.pitch} semitones (over 10)`);
  });

  it("uses the cut's and the performance's thresholds over the defaults", () => {
    const t = timeline({ check: { thresholds: { pause: 1 } }, performances: [{ id: 'joke', lines: ['setup', 'payoff'], thresholds: { loudness: 30 } }] });
    expect(thresholdsFor(t, t.performances[0])).toEqual({ ...DEFAULT_THRESHOLDS, pause: 1, loudness: 30 });
    const p = measureCut(t, stem({ ampB: 0.3 })).performances[0];
    expect(p.flags.map((f) => f.code)).toEqual(['splitting-rule']);
  });

  it("judges only the energy across another speaker's lines, and ignores the cuts to their shots", () => {
    const t = timeline({
      segments: [
        { id: 'a', src: 'take:a', in: 0, out: 2 },
        { id: 'w', src: 'take:w', in: 0, out: 1 },
        { id: 'b', src: 'take:b', in: 0, out: 1.5 },
      ],
      lines: [
        { id: 'setup', speaker: 'Hal', text: 'This one even comes with', segment: 'a', words: words('This one even comes with', 0.3, 1.6) },
        { id: 'wife', speaker: 'Wife', text: 'With what?', segment: 'w', words: words('With what?', 0.1, 0.8) },
        { id: 'payoff', speaker: 'Hal', text: 'wheels and a great big bow', segment: 'b', words: words('wheels and a great big bow', 0.1, 1.4) },
      ],
      performances: [{ id: 'joke', lines: ['setup', 'payoff'] }],
    });
    const samples = new Float32Array(Math.round(4.5 * SR));
    samples.set(noise(4.5, -60), 0);
    voice(samples, 0.3, 1.6, 130, 0.05);
    voice(samples, 2.1, 2.8, 220, 0.05);
    voice(samples, 3.1, 4.4, 300, 0.05);
    const p = measureCut(t, { audio: { samples, sampleRate: SR }, start: 0 }).performances[0];
    expect(p.boundaries[0].between).toEqual(['wife']);
    expect(p.boundaries[0].pitch).toBeGreaterThan(10);
    expect(p.flags.map((f) => f.code)).toEqual(['splitting-rule']);
    expect(p.cuts).toEqual([]);
  });

  it("carries the splitting rule's problems as flags", () => {
    const p = measureCut(timeline(), stem()).performances[0];
    expect(timeline().performances[0].splits.map((s) => s.code)).toEqual(['separate-generations']);
    expect(p.splits.map((s) => s.code)).toEqual(['separate-generations']);
    // The splitting rule's flag is in the performance's flags, ahead of the measured ones.
    expect(p.flags[0]).toEqual({ code: 'splitting-rule', lines: ['setup', 'payoff'], message: 'splitting rule (separate-generations): its lines come from 2 generations (setup from take:a; payoff from take:b); a sentence, and a setup with its payoff, should be one' });
  });

  it("flags a line outside its speaker's reference levels, the hook for a character's delivery profile", () => {
    const m = measureCut(timeline(), stem({ ampB: 0.3 }), { reference: (speaker) => (speaker === 'Hal' ? { loudness: { max: -25 }, source: 'approved lines' } : undefined) });
    const flagged = m.lines.filter((l) => l.flags.some((f) => f.code === 'outside-reference')).map((l) => l.id);
    expect(flagged).toEqual(['payoff']);
    expect(m.lines[1].flags[0].message).toMatch(/^payoff: loudness -\d+(\.\d)? LUFS is above Hal's reference, -25 LUFS \(approved lines\)$/);
  });

  it('measures a line with no word timings whole, and says so', () => {
    const t = timeline({ lines: [{ id: 'setup', speaker: 'Hal', text: 'This one even comes with', segment: 'a' }], performances: [] });
    const m = measureCut(t, stem());
    expect(m.lines[0].timedBy).toBe('line');
    expect(m.lines[0].rate).toBeNull();
    expect(m.lines[0].flags.map((f) => f.code)).toEqual(['unmeasured']);
  });
});

describe('the splitting rule in a measured performance', () => {
  it('is one flag per problem, worded as the rule', () => {
    const t = timeline();
    const p = measureCut(t, stem()).performances[0];
    // separate sources: take:a and take:b
    expect(p.splits[0].message).toContain('2 generations');
  });
});

describe('delivery in words', () => {
  it('says how steady, how loud, how high and how fast', () => {
    expect(describeDelivery({ loudness: -24, pitch: { median: 140, low: 120, high: 160, range: 3, voiced: 0.8 }, rate: { words: 2.6, syllables: 3.4 } })).toBe(
      'steady, projected level, mid pitch, 2.6 words/s',
    );
    const others = [{ pitch: { median: 120, low: 0, high: 0, range: 0, voiced: 0 } }, { pitch: { median: 125, low: 0, high: 0, range: 0, voiced: 0 } }];
    expect(describeDelivery({ loudness: -28, pitch: { median: 160, low: 0, high: 0, range: 12, voiced: 0 }, rate: null }, others)).toBe(
      "very animated, conversational level, higher than this voice's other lines (+4.6 semitones)",
    );
  });
});

describe('the listening check', () => {
  it('asks about phrases with their times in the clip, never about cuts', () => {
    const t = timeline({ lines: [
      { id: 'setup', speaker: 'Hal', text: 'This one even comes with', segment: 'a', words: words('This one even comes with', 0.3, 1.6) },
      { id: 'payoff', speaker: 'Hal', text: 'wheels and a great big bow', segment: 'b', words: words('wheels and a great big bow', 0.4, 1.9), delivery: 'the same note as "comes with"' },
    ] });
    const perf = t.performances[0];
    const range = clipRange(t, perf);
    expect(range).toEqual({ from: 0, to: 4.38 });
    const qs = listeningQuestions(t, perf, range.from);
    expect(qs.map((q) => [q.id, q.kind, q.expect])).toEqual([
      ['joke.continuous.setup.payoff', 'continuous', 'yes'],
      ['joke.shouted.setup', 'shouted', 'no'],
      ['joke.shouted.payoff', 'shouted', 'no'],
      ['joke.delivery', 'delivery', 'yes'],
      ['joke.delivery.payoff', 'delivery', 'yes'],
    ]);
    expect(qs[0].ask).toBe('Do "This one even comes with" (0.30–1.58 s) and "wheels and a great big bow" (2.40–3.88 s) sound like one continuous delivery by the same speaker, rather than two separately recorded deliveries?');
    expect(qs[1].ask).toBe('Is any word in "This one even comes with" (0.30–1.58 s) shouted?');
    expect(qs[3].ask).toBe('Is "This one even comes with wheels and a great big bow" (0.30–3.88 s) delivered like this: an ordinary selling point, no pause before "wheels"? Answer yes or no.');
    expect(listeningFacts(t, range).split('\n')).toEqual([
      'The clip is 4.38 s long. Times are seconds from its start, measured from the words.',
      'Speech in the clip:',
      '- 0.30–1.58 s, Hal: "This one even comes with"',
      '- 2.40–3.88 s, Hal: "wheels and a great big bow"',
    ]);
  });

  it('asks whether a line on its own is one continuous delivery all the way through', () => {
    const t = timeline({ performances: [{ id: 'one', lines: ['setup'] }] });
    const qs = listeningQuestions(t, t.performances[0], 0);
    expect(qs.map((q) => q.id)).toEqual(['one.continuous', 'one.shouted.setup']);
  });

  it('reads verdicts as yes, no or unclear, and checks them against what each question expects', () => {
    expect(['yes', 'Yes, clearly', 'one continuous delivery', 'no', 'two separate deliveries', 'not shouted', "can't tell", 'shouted', 'big reveal'].map(readVerdict)).toEqual(
      ['yes', 'yes', 'yes', 'no', 'no', 'no', 'unclear', 'yes', 'unclear'],
    );
    const t = timeline();
    const qs = listeningQuestions(t, t.performances[0], 0);
    const checked = checkAnswers(qs, [
      { id: 'joke.continuous.setup.payoff', verdict: 'two separate deliveries', confidence: 0.95, heard: 'a pause, then a shout', why: 'the energy jumps' },
      { id: 'joke.shouted.setup', verdict: 'no', confidence: 0.9, heard: '', why: '' },
    ]);
    expect(checked.map((a) => [a.id, a.reading, a.agrees])).toEqual([
      ['joke.continuous.setup.payoff', 'no', false],
      ['joke.shouted.setup', 'no', true],
      ['joke.shouted.payoff', 'unclear', false],
      ['joke.delivery', 'unclear', false],
    ]);
    expect(checked[2].why).toBe('the listener gave no answer to this question');
  });
});

describe('the check file', () => {
  it('fingerprints a stretch by what is heard there, so it goes stale when that changes and not otherwise', () => {
    const a = fingerprintMaterial(timeline(), 0, 4.5);
    expect(a.refs).toEqual(['take:a', 'take:b']);
    const relabelled = timeline({ segments: [{ id: 'a', label: 'New label', src: 'take:a', in: 0, out: 2 }, { id: 'b', src: 'take:b', in: 0, out: 2.5 }] });
    expect(fingerprintMaterial(relabelled, 0, 4.5).material).toBe(a.material);
    const moved = timeline({ segments: [{ id: 'a', src: 'take:a', in: 0.1, out: 2.1 }, { id: 'b', src: 'take:b', in: 0, out: 2.5 }] });
    expect(fingerprintMaterial(moved, 0, 4.5).material).not.toBe(a.material);
    // Outside the stretch, nothing counts.
    expect(fingerprintMaterial(moved, 2.5, 4.5).material).toBe(fingerprintMaterial(timeline(), 2.5, 4.5).material);

    const stored = { from: 0, to: 4.5, sources: { 'take:a': 'aa', 'take:b': 'bb' }, digest: 'd1' };
    expect(fingerprintChange(stored, { ...stored })).toBeNull();
    expect(fingerprintChange(stored, { ...stored, digest: 'd2' })).toBe('the cut changed there');
    expect(fingerprintChange(stored, { ...stored, sources: { 'take:a': 'aa', 'take:b': 'cc' } })).toBe('take:b changed');
  });

  it('writes the same bytes for the same content and reads them back', () => {
    const m = measureCut(timeline(), stem());
    const file: CheckFile = { format: CHECK_FORMAT, measured: { ...m, fingerprints: { lines: {}, performances: {} } }, listening: {} };
    const text = serializeCheckFile(file);
    expect(serializeCheckFile(JSON.parse(text) as CheckFile)).toBe(text);
    const parsed = parseCheckFile(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    expect(parseCheckFile({ format: 'x' })).toEqual({ ok: false, message: `format: expected "${CHECK_FORMAT}"` });
  });
});
