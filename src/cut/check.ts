import { frameLevels, type PcmAudio } from './onset.js';
import { countSyllables, decimate, gatedLoudness, kWeight, median, quantile, semitones, shortLoudness, yinPitch } from './prosody.js';
import { readVerdict, type ListenAnswer, type VerdictReading } from './listen.js';
import type {
  CheckThresholds,
  PerformanceSplit,
  ResolvedLine,
  ResolvedPerformance,
  SourceRef,
  Timeline,
  TimelineItem,
  Word,
} from './types.js';

/**
 * `mdmedia cut check`: performance continuity, measured and listened to.
 * Everything here is pure: it measures decoded samples of the cut's dialogue
 * as rendered, works out the flags, writes the listening check's questions,
 * and reads and writes the check file. Rendering, hashing and the model are
 * in check-run.ts. See docs/cut-check.md.
 */

/** The value of a check file's `format` field. */
export const CHECK_FORMAT = 'mdmedia.cut-check@1';

/**
 * How the measured check is made; kept in the file. Change it whenever the
 * measurements change, so stored results are known to be from another method.
 */
export const MEASURE_METHOD = 'dialogue-stem@1';

/** What the measurements are taken from, in words, as the file and the CLI say it. */
export const MEASURE_SOURCE =
  "a render of the cut's dialogue: every segment's own sound and every line with its own sound, at the cut's volumes, fades and layers, without music or sound effects, mono 48 kHz";

/**
 * The thresholds a cut gets unless it sets its own (`check.thresholds`), from
 * the calibration in docs/cut-check.md: Big Hal Take 5 (known bad) against
 * Takes 6 and 7 and Night Wagon Take 9 (known good).
 */
export const DEFAULT_THRESHOLDS: Required<CheckThresholds> = {
  loudness: 2.5,
  pitch: 10,
  rate: 0.4,
  pause: 0.6,
  roomTone: 5,
  word: 6,
};

/** The thresholds for one performance: the defaults, then the cut's, then its own. */
export function thresholdsFor(timeline: Pick<Timeline, 'check'>, performance?: Pick<ResolvedPerformance, 'thresholds'>): Required<CheckThresholds> {
  return { ...DEFAULT_THRESHOLDS, ...timeline.check.thresholds, ...performance?.thresholds };
}

// ---------------------------------------------------------------------------
// Reference levels: the hook for a character's delivery profile

/** A range; either end may be open. */
export interface LevelRange {
  min?: number;
  max?: number;
}

/**
 * A speaker's reference levels, measured from their approved lines: what
 * "too loud for Hal" is in numbers. The cast's delivery profiles supply these
 * (`CheckOptions.reference`); a line outside them is flagged.
 */
export interface ReferenceLevels {
  /** Gated loudness, LUFS. */
  loudness?: LevelRange;
  /** Median pitch, Hz. */
  pitch?: LevelRange;
  /** Pitch range (10th to 90th percentile), semitones. */
  pitchRange?: LevelRange;
  /** Speech rate, words per second. */
  rate?: LevelRange;
  /** Where the levels came from, e.g. "Big Hal's approved lines in Take 7". */
  source?: string;
}

/** A speaker's reference levels, or undefined when there are none. */
export type ReferenceFor = (speaker: string) => ReferenceLevels | undefined;

// ---------------------------------------------------------------------------
// Measurements

/** The cut's dialogue, rendered: its samples, and the timeline time of the first. */
export interface StemAudio {
  audio: PcmAudio;
  /** Timeline seconds at sample 0. */
  start: number;
}

export type FlagCode =
  | 'loudness-jump'
  | 'pitch-jump'
  | 'rate-jump'
  | 'long-pause'
  | 'room-tone-jump'
  | 'loud-word'
  | 'outside-reference'
  | 'splitting-rule'
  | 'unmeasured';

export interface CheckFlag {
  code: FlagCode;
  message: string;
  /** The measured value and the threshold it crossed, when there are numbers. */
  value?: number;
  threshold?: number;
  lines?: string[];
}

export interface PitchSummary {
  /** Median pitch of the voiced frames, Hz. */
  median: number;
  /** 10th and 90th percentiles, Hz. */
  low: number;
  high: number;
  /** From the 10th to the 90th percentile, semitones. */
  range: number;
  /** Voiced frames, as a fraction of the frames in its words. */
  voiced: number;
}

export interface WordLevel {
  text: string;
  start: number;
  end: number;
  /** Ungated loudness over the word, LUFS, or null when silent. */
  loudness: number | null;
}

export interface LineMeasure {
  id: string;
  speaker: string;
  text: string;
  /** Its speech on the timeline: first word's start to last word's end (or the whole line without words). */
  speech: { start: number; end: number };
  /** `words`: timed by its words file. `line`: it has no words, so its whole span was measured, and it has no rate or pauses. */
  timedBy: 'words' | 'line';
  words: number;
  /** Estimated syllables in its text. */
  syllables: number;
  /** Gated loudness over its speech, LUFS. */
  loudness: number | null;
  pitch: PitchSummary | null;
  /** Words and syllables per second of speech. Null without word timings. */
  rate: { words: number; syllables: number } | null;
  wordLevels: WordLevel[];
  flags: CheckFlag[];
}

/** The edge of a line next to a boundary: the words nearest it, at least `EDGE_SECONDS` of speech or the whole line. */
export interface EdgeMeasure {
  words: string;
  start: number;
  end: number;
  loudness: number | null;
  /** Median pitch, Hz. */
  pitch: number | null;
}

export interface BoundaryMeasure {
  from: string;
  to: string;
  /** Lines heard between the two (another speaker's, say); a pause across them isn't judged. */
  between: string[];
  /** Seconds from the last word of `from` to the first word of `to`, from word timings. Null without them. */
  pause: number | null;
  /** The end of `from` and the start of `to`. */
  before: EdgeMeasure;
  after: EdgeMeasure;
  /** `after` less `before`, LU. */
  loudness: number | null;
  /** `after` against `before`, semitones. */
  pitch: number | null;
  /** The change in syllables per second, line against line, as a fraction of the slower. Null when either line is too short to say. */
  rate: number | null;
  flags: CheckFlag[];
}

export interface CutToneMeasure {
  /** Timeline seconds of the segment cut. */
  at: number;
  from: string;
  to: string;
  /** Median level of the frames without speech just before and just after the cut, dBFS. */
  before: number | null;
  after: number | null;
  /** `after` less `before`, dB. */
  change: number | null;
  /** True when there wasn't enough room tone next to the cut and its segments' other quiet frames were used. */
  wide: boolean;
  flags: CheckFlag[];
}

export interface PerformanceMeasure {
  id: string;
  lines: string[];
  thresholds: Required<CheckThresholds>;
  boundaries: BoundaryMeasure[];
  /** Room tone across each segment cut inside its speech. */
  cuts: CutToneMeasure[];
  /** The splitting rule, from the resolved performance. */
  splits: PerformanceSplit[];
  /** Every flag: the splitting rule's, its boundaries', its cuts' and its loud words'. */
  flags: CheckFlag[];
}

export interface MeasuredCheck {
  method: string;
  source: string;
  /** The stretch of the timeline the stem covers. */
  range: { from: number; to: number };
  lines: LineMeasure[];
  performances: PerformanceMeasure[];
}

export interface CheckOptions {
  /** Each speaker's reference levels (the character's delivery profile). */
  reference?: ReferenceFor;
}

/** Seconds of speech an edge measures at least, in whole words. */
export const EDGE_SECONDS = 0.8;
/** Frames this close to a word, or to a segment cut (its mix fades), aren't room tone. */
const WORD_MARGIN = 0.05;
const CUT_MARGIN = 0.03;
/** How far either side of a cut room tone is looked for first. */
const TONE_WINDOW = 0.6;
const TONE_FRAME = 0.02;
const MIN_TONE_FRAMES = 3;
const PITCH_RATE = 16_000;
/** Fewer syllables than this say too little about a line's rate. */
const MIN_RATE_SYLLABLES = 4;
const EPS = 1e-6;

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function roundOrNull(value: number | null, places = 2): number | null {
  return value === null || !Number.isFinite(value) ? null : round(value, places);
}

/** Prepared once per stem: the K-weighted signal, a 16 kHz copy for pitch, and frame levels for room tone. */
interface Prepared {
  stem: StemAudio;
  weighted: Float64Array;
  low: PcmAudio;
  levels: number[];
}

function prepare(stem: StemAudio): Prepared {
  const factor = Math.max(1, Math.round(stem.audio.sampleRate / PITCH_RATE));
  return { stem, weighted: kWeight(stem.audio), low: decimate(stem.audio, factor), levels: frameLevels(stem.audio.samples, stem.audio.sampleRate, TONE_FRAME) };
}

/** Voiced pitch frames (Hz) inside these word spans (timeline seconds). */
function pitchIn(p: Prepared, spans: ReadonlyArray<{ start: number; end: number }>): { hz: number[]; frames: number } {
  const hz: number[] = [];
  let frames = 0;
  for (const span of spans) {
    const from = span.start - p.stem.start;
    const to = span.end - p.stem.start;
    if (to <= from) continue;
    const track = yinPitch(p.low, from, to);
    frames += track.length;
    for (const f of track) {
      if (f.hz === null) continue;
      // Skip near-silent frames: YIN finds "pitch" in a quiet hum.
      const level = p.levels[Math.floor((f.t) / TONE_FRAME)];
      if (level !== undefined && level < -55) continue;
      hz.push(f.hz);
    }
  }
  return { hz, frames };
}

function summarizePitch(hz: number[], frames: number): PitchSummary | null {
  if (hz.length < 5) return null;
  const low = quantile(hz, 0.1);
  const high = quantile(hz, 0.9);
  return { median: round(median(hz), 1), low: round(low, 1), high: round(high, 1), range: round(semitones(high, low), 1), voiced: round(hz.length / Math.max(1, frames)) };
}

function speechOf(line: ResolvedLine): { start: number; end: number; timedBy: 'words' | 'line' } {
  if (line.words.length === 0) return { start: line.start, end: line.end, timedBy: 'line' };
  return { start: Math.min(...line.words.map((w) => w.start)), end: Math.max(...line.words.map((w) => w.end)), timedBy: 'words' };
}

function syllablesIn(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).reduce((n, w) => n + countSyllables(w), 0);
}

function referenceFlags(m: LineMeasure, ref: ReferenceLevels): CheckFlag[] {
  const flags: CheckFlag[] = [];
  const check = (what: string, value: number | null | undefined, range: LevelRange | undefined, unit: string): void => {
    if (value === null || value === undefined || !range) return;
    const from = ref.source ? ` (${ref.source})` : '';
    if (range.max !== undefined && value > range.max) {
      flags.push({ code: 'outside-reference', lines: [m.id], value, threshold: range.max, message: `${m.id}: ${what} ${value}${unit} is above ${m.speaker}'s reference, ${range.max}${unit}${from}` });
    } else if (range.min !== undefined && value < range.min) {
      flags.push({ code: 'outside-reference', lines: [m.id], value, threshold: range.min, message: `${m.id}: ${what} ${value}${unit} is below ${m.speaker}'s reference, ${range.min}${unit}${from}` });
    }
  };
  check('loudness', m.loudness, ref.loudness, ' LUFS');
  check('pitch', m.pitch?.median, ref.pitch, ' Hz');
  check('pitch range', m.pitch?.range, ref.pitchRange, ' st');
  check('speech rate', m.rate?.words, ref.rate, ' words/s');
  return flags;
}

function measureLine(p: Prepared, line: ResolvedLine, reference?: ReferenceFor): LineMeasure {
  const { start, end, timedBy } = speechOf(line);
  const sr = p.stem.audio.sampleRate;
  const t0 = p.stem.start;
  const spans: Word[] = timedBy === 'words' ? line.words : [{ text: line.text, start, end }];
  const pitch = pitchIn(p, spans);
  const duration = end - start;
  const syllables = syllablesIn(line.text);
  const m: LineMeasure = {
    id: line.id,
    speaker: line.speaker,
    text: line.text,
    speech: { start: round(start, 3), end: round(end, 3) },
    timedBy,
    words: timedBy === 'words' ? line.words.length : 0,
    syllables,
    loudness: roundOrNull(gatedLoudness(p.weighted, sr, start - t0, end - t0), 1),
    pitch: summarizePitch(pitch.hz, pitch.frames),
    rate: timedBy === 'words' && duration > EPS ? { words: round(line.words.length / duration), syllables: round(syllables / duration) } : null,
    wordLevels: timedBy === 'words'
      ? line.words.map((w) => ({ text: w.text, start: round(w.start, 3), end: round(w.end, 3), loudness: roundOrNull(shortLoudness(p.weighted, sr, w.start - t0, w.end - t0), 1) }))
      : [],
    flags: [],
  };
  if (timedBy === 'line') m.flags.push({ code: 'unmeasured', lines: [line.id], message: `${line.id} has no word timings, so its whole span was measured and its rate and pauses can't be (run mdmedia cut words)` });
  const ref = reference?.(line.speaker);
  if (ref) m.flags.push(...referenceFlags(m, ref));
  return m;
}

/** The words of a line nearest one of its ends, covering at least `EDGE_SECONDS` (or the whole line). */
function edgeWords(line: ResolvedLine, side: 'start' | 'end'): Word[] {
  const words = line.words.length > 0 ? line.words : [{ text: line.text, start: line.start, end: line.end }];
  const ordered = side === 'end' ? [...words].reverse() : words;
  const picked: Word[] = [];
  for (const w of ordered) {
    picked.push(w);
    const span = side === 'end' ? picked[0].end - w.start : w.end - picked[0].start;
    if (span >= EDGE_SECONDS) break;
  }
  return side === 'end' ? picked.reverse() : picked;
}

function measureEdge(p: Prepared, words: Word[]): EdgeMeasure {
  const start = words[0].start;
  const end = words[words.length - 1].end;
  const sr = p.stem.audio.sampleRate;
  const pitch = pitchIn(p, words);
  return {
    words: words.map((w) => w.text).join(' '),
    start: round(start, 3),
    end: round(end, 3),
    loudness: roundOrNull(gatedLoudness(p.weighted, sr, start - p.stem.start, end - p.stem.start), 1),
    pitch: pitch.hz.length >= 3 ? round(median(pitch.hz), 1) : null,
  };
}

function quote(text: string, max = 40): string {
  return `"${text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}"`;
}

function measureBoundary(p: Prepared, timeline: Timeline, a: LineMeasure, b: LineMeasure, t: Required<CheckThresholds>): BoundaryMeasure {
  const la = timeline.lines.find((l) => l.id === a.id) as ResolvedLine;
  const lb = timeline.lines.find((l) => l.id === b.id) as ResolvedLine;
  const before = measureEdge(p, edgeWords(la, 'end'));
  const after = measureEdge(p, edgeWords(lb, 'start'));
  const between = timeline.lines
    .filter((l) => l.id !== a.id && l.id !== b.id && l.start < b.speech.start - EPS && l.end > a.speech.end + EPS && speechOf(l).start >= a.speech.start)
    .map((l) => l.id);
  const timed = a.timedBy === 'words' && b.timedBy === 'words';
  const pause = timed ? round(b.speech.start - a.speech.end, 3) : null;
  const loudness = before.loudness !== null && after.loudness !== null ? round(after.loudness - before.loudness, 1) : null;
  const pitch = before.pitch !== null && after.pitch !== null ? round(semitones(after.pitch, before.pitch), 1) : null;
  let rate: number | null = null;
  if (a.rate && b.rate && a.syllables >= MIN_RATE_SYLLABLES && b.syllables >= MIN_RATE_SYLLABLES) {
    rate = round((b.rate.syllables - a.rate.syllables) / Math.min(a.rate.syllables, b.rate.syllables));
  }
  const flags: CheckFlag[] = [];
  const lines = [a.id, b.id];
  const where = `${quote(before.words)} → ${quote(after.words)}`;
  // Across another speaker's lines, only the energy should carry over: pitch, pace and pauses move with the exchange.
  const adjacent = between.length === 0;
  if (loudness !== null && Math.abs(loudness) > t.loudness) {
    flags.push({ code: 'loudness-jump', lines, value: loudness, threshold: t.loudness, message: `${where}: loudness ${loudness > 0 ? 'jumps up' : 'drops'} ${Math.abs(loudness)} LU (over ${t.loudness})` });
  }
  if (adjacent && pitch !== null && Math.abs(pitch) > t.pitch) {
    flags.push({ code: 'pitch-jump', lines, value: pitch, threshold: t.pitch, message: `${where}: pitch ${pitch > 0 ? 'jumps up' : 'drops'} ${Math.abs(pitch)} semitones (over ${t.pitch})` });
  }
  if (adjacent && rate !== null && Math.abs(rate) > t.rate) {
    flags.push({ code: 'rate-jump', lines, value: rate, threshold: t.rate, message: `${a.id} → ${b.id}: speech rate ${rate > 0 ? 'speeds up' : 'slows'} ${Math.round(Math.abs(rate) * 100)} % (over ${Math.round(t.rate * 100)} %)` });
  }
  if (adjacent && pause !== null && pause > t.pause) {
    flags.push({ code: 'long-pause', lines, value: pause, threshold: t.pause, message: `${where}: a ${pause} s pause (over ${t.pause} s)` });
  }
  return { from: a.id, to: b.id, between, pause, before, after, loudness, pitch, rate, flags };
}

/** The median level of the frames from `from` to `to` that are clear of speech and cuts, or null with too few. */
function toneLevel(p: Prepared, from: number, to: number, speech: ReadonlyArray<{ start: number; end: number }>, cuts: readonly number[]): { level: number | null; frames: number } {
  const levels: number[] = [];
  const first = Math.max(0, Math.ceil((from - p.stem.start) / TONE_FRAME));
  const last = Math.min(p.levels.length - 1, Math.floor((to - p.stem.start) / TONE_FRAME) - 1);
  for (let f = first; f <= last; f++) {
    const s = p.stem.start + f * TONE_FRAME;
    const e = s + TONE_FRAME;
    if (speech.some((w) => s < w.end + WORD_MARGIN && e > w.start - WORD_MARGIN)) continue;
    if (cuts.some((c) => s < c + CUT_MARGIN && e > c - CUT_MARGIN)) continue;
    levels.push(p.levels[f]);
  }
  if (levels.length < MIN_TONE_FRAMES) return { level: null, frames: levels.length };
  return { level: round(median(levels), 1), frames: levels.length };
}

/**
 * The stretches a performance is heard without a break: each of its lines,
 * and each gap between two of them with no other line in it.
 */
function continuousStretches(lines: LineMeasure[], boundaries: BoundaryMeasure[]): Array<{ start: number; end: number }> {
  const out = lines.map((l) => ({ start: l.speech.start, end: l.speech.end }));
  for (const b of boundaries) {
    if (b.between.length > 0) continue;
    const a = lines.find((l) => l.id === b.from);
    const c = lines.find((l) => l.id === b.to);
    if (a && c) out.push({ start: a.speech.end, end: c.speech.start });
  }
  return out;
}

function measureCuts(p: Prepared, timeline: Timeline, lines: LineMeasure[], boundaries: BoundaryMeasure[], t: Required<CheckThresholds>): CutToneMeasure[] {
  const stretches = continuousStretches(lines, boundaries);
  const speech = timeline.lines.flatMap((l) => (l.words.length > 0 ? l.words : [{ text: l.text, start: l.start, end: l.end }]));
  const cutTimes = timeline.segments.slice(1).map((s) => s.start);
  const out: CutToneMeasure[] = [];
  for (let i = 1; i < timeline.segments.length; i++) {
    const prev = timeline.segments[i - 1];
    const next = timeline.segments[i];
    const at = next.start;
    if (!stretches.some((r) => at > r.start + EPS && at < r.end - EPS)) continue;
    let wide = false;
    let before = toneLevel(p, Math.max(prev.start, at - TONE_WINDOW), at, speech, cutTimes);
    let after = toneLevel(p, at, Math.min(next.end, at + TONE_WINDOW), speech, cutTimes);
    if (before.level === null || after.level === null) {
      wide = true;
      if (before.level === null) before = toneLevel(p, prev.start, at, speech, cutTimes);
      if (after.level === null) after = toneLevel(p, at, next.end, speech, cutTimes);
    }
    const change = before.level !== null && after.level !== null ? round(after.level - before.level, 1) : null;
    const flags: CheckFlag[] = [];
    if (change !== null && Math.abs(change) > t.roomTone) {
      flags.push({
        code: 'room-tone-jump', value: change, threshold: t.roomTone,
        message: `the cut ${prev.id} → ${next.id} at ${round(at, 2)} s: room tone ${change > 0 ? 'rises' : 'drops'} ${Math.abs(change)} dB (over ${t.roomTone})`,
      });
    }
    out.push({ at: round(at, 3), from: prev.id, to: next.id, before: before.level, after: after.level, change, wide, flags });
  }
  return out;
}

function loudWords(lines: LineMeasure[], t: Required<CheckThresholds>): CheckFlag[] {
  const words = lines.flatMap((l) => l.wordLevels.map((w) => ({ ...w, line: l.id })));
  const levels = words.map((w) => w.loudness).filter((x): x is number => x !== null);
  if (levels.length < 3) return [];
  const mid = median(levels);
  return words
    .filter((w) => w.loudness !== null && w.loudness - mid > t.word)
    .map((w) => ({
      code: 'loud-word' as const,
      lines: [w.line],
      value: round((w.loudness as number) - mid, 1),
      threshold: t.word,
      message: `${quote(w.text)} (${w.line}, ${round(w.start, 2)} s) is ${round((w.loudness as number) - mid, 1)} LU louder than the performance's median word (over ${t.word})`,
    }));
}

/**
 * Measures every line of a cut in its rendered dialogue, then each
 * performance: the change across each boundary between its lines, the pause
 * there, the room tone across each segment cut inside it, and its loudest
 * words, flagging what crosses its thresholds.
 */
export function measureCut(timeline: Timeline, stem: StemAudio, options: CheckOptions = {}): MeasuredCheck {
  const p = prepare(stem);
  const lines = timeline.lines.filter((l) => !l.sung).map((l) => measureLine(p, l, options.reference));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const performances: PerformanceMeasure[] = timeline.performances.map((perf) => {
    const t = thresholdsFor(timeline, perf);
    const own = perf.lines.map((id) => byId.get(id)).filter((m): m is LineMeasure => m !== undefined);
    const boundaries: BoundaryMeasure[] = [];
    for (let i = 1; i < own.length; i++) boundaries.push(measureBoundary(p, timeline, own[i - 1], own[i], t));
    const cuts = own.length > 0 ? measureCuts(p, timeline, own, boundaries, t) : [];
    const flags: CheckFlag[] = [
      ...perf.splits.map((s) => ({ code: 'splitting-rule' as const, lines: s.lines, message: `splitting rule (${s.code}): ${s.message}` })),
      ...boundaries.flatMap((b) => b.flags),
      ...cuts.flatMap((c) => c.flags),
      ...loudWords(own, t),
    ];
    return { id: perf.id, lines: perf.lines, thresholds: t, boundaries, cuts, splits: perf.splits, flags };
  });
  const end = stem.start + stem.audio.samples.length / stem.audio.sampleRate;
  return { method: MEASURE_METHOD, source: MEASURE_SOURCE, range: { from: round(stem.start, 3), to: round(end, 3) }, lines, performances };
}

// ---------------------------------------------------------------------------
// Delivery in words

/**
 * A line's measured delivery in plain words, for a storyboard: "steady,
 * conversational level, mid pitch, 2.6 words/s". `others` are the same
 * speaker's other lines, so pitch is described against their own voice.
 */
export function describeDelivery(m: Pick<LineMeasure, 'loudness' | 'pitch' | 'rate'>, others: ReadonlyArray<Pick<LineMeasure, 'pitch'>> = []): string {
  const parts: string[] = [];
  // Bands from the CRT TV lines: a 10th-to-90th percentile range of 6-11 semitones is ordinary speech.
  if (m.pitch) parts.push(m.pitch.range < 7 ? 'steady' : m.pitch.range < 11 ? 'lively' : 'very animated');
  if (m.loudness !== null) {
    const l = m.loudness;
    parts.push(`${l < -32 ? 'quiet' : l < -25 ? 'conversational' : l < -19 ? 'projected' : 'loud'} level`);
  }
  if (m.pitch) {
    const medians = others.map((o) => o.pitch?.median).filter((x): x is number => x !== undefined);
    if (medians.length >= 2) {
      const d = semitones(m.pitch.median, median(medians));
      parts.push(Math.abs(d) <= 1.5 ? 'mid pitch for this voice' : d > 0 ? `higher than this voice's other lines (+${round(d, 1)} semitones)` : `lower than this voice's other lines (${round(d, 1)} semitones)`);
    } else {
      const hz = m.pitch.median;
      parts.push(hz < 100 ? 'low pitch' : hz < 170 ? 'mid pitch' : hz < 260 ? 'raised pitch' : 'high pitch');
    }
  }
  if (m.rate) parts.push(`${m.rate.words} words/s`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// The listening check's questions

export type QuestionKind = 'continuous' | 'shouted' | 'delivery';

export interface ListenQuestion {
  id: string;
  kind: QuestionKind;
  ask: string;
  /** The answer the performance should get. */
  expect: 'yes' | 'no';
  lines: string[];
}

/** The stretch of the cut a performance's clip covers: its speech, with half a second either side. */
export function clipRange(timeline: Timeline, performance: ResolvedPerformance, pad = 0.5): { from: number; to: number } {
  const lines = performance.lines.map((id) => timeline.lines.find((l) => l.id === id)).filter((l): l is ResolvedLine => l !== undefined);
  const from = Math.min(...lines.map((l) => speechOf(l).start));
  const to = Math.max(...lines.map((l) => speechOf(l).end));
  return { from: round(Math.max(0, from - pad), 3), to: round(Math.min(timeline.length, to + pad), 3) };
}

function secs(t: number): string {
  return t.toFixed(2);
}

/**
 * The listening check's questions for a performance, about phrases with their
 * exact times in the clip (from `clipFrom` on the timeline), never about cuts:
 * whether each pair of its lines sounds like one continuous delivery (or a
 * line on its own, all the way through), whether any word of each line is
 * shouted, and its delivery directions as yes/no questions.
 */
export function listeningQuestions(timeline: Timeline, performance: ResolvedPerformance, clipFrom: number): ListenQuestion[] {
  const lines = performance.lines.map((id) => timeline.lines.find((l) => l.id === id)).filter((l): l is ResolvedLine => l !== undefined);
  const at = (l: ResolvedLine): string => {
    const s = speechOf(l);
    return `${secs(s.start - clipFrom)}–${secs(s.end - clipFrom)} s`;
  };
  const qs: ListenQuestion[] = [];
  if (lines.length === 1) {
    const l = lines[0];
    qs.push({ id: `${performance.id}.continuous`, kind: 'continuous', expect: 'yes', lines: [l.id], ask: `Does "${l.text}" (${at(l)}) sound like one continuous delivery all the way through, rather than pieces of separately recorded deliveries?` });
  }
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    qs.push({
      id: `${performance.id}.continuous.${a.id}.${b.id}`, kind: 'continuous', expect: 'yes', lines: [a.id, b.id],
      ask: `Do "${a.text}" (${at(a)}) and "${b.text}" (${at(b)}) sound like one continuous delivery by the same speaker, rather than two separately recorded deliveries?`,
    });
  }
  for (const l of lines) {
    qs.push({ id: `${performance.id}.shouted.${l.id}`, kind: 'shouted', expect: 'no', lines: [l.id], ask: `Is any word in "${l.text}" (${at(l)}) shouted?` });
  }
  if (performance.delivery) {
    const first = speechOf(lines[0]).start;
    const last = speechOf(lines[lines.length - 1]).end;
    qs.push({
      id: `${performance.id}.delivery`, kind: 'delivery', expect: 'yes', lines: lines.map((l) => l.id),
      ask: `Is "${lines.map((l) => l.text).join(' ')}" (${secs(first - clipFrom)}–${secs(last - clipFrom)} s) delivered like this: ${performance.delivery}? Answer yes or no.`,
    });
  }
  for (const l of lines) {
    if (!l.delivery) continue;
    qs.push({ id: `${performance.id}.delivery.${l.id}`, kind: 'delivery', expect: 'yes', lines: [l.id], ask: `Is "${l.text}" (${at(l)}) delivered like this: ${l.delivery}? Answer yes or no.` });
  }
  return qs;
}

/** Known facts about a clip for the listener: every line heard in it, with its speaker and exact times from the clip's start. */
export function listeningFacts(timeline: Timeline, range: { from: number; to: number }): string {
  const heard = timeline.lines.filter((l) => l.end > range.from + EPS && l.start < range.to - EPS);
  const rows = heard.map((l) => {
    const s = speechOf(l);
    return `- ${secs(Math.max(0, s.start - range.from))}–${secs(Math.min(range.to, s.end) - range.from)} s, ${l.speaker}: "${l.text}"`;
  });
  return [`The clip is ${secs(range.to - range.from)} s long. Times are seconds from its start, measured from the words.`, 'Speech in the clip:', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// The check file

/** What a stored result was measured from: the stretch of the cut, the files heard in it, and a digest of everything on the timeline there. */
export interface CheckFingerprint {
  from: number;
  to: number;
  /** SHA-256 of each source file heard in the stretch, by its ref as written. */
  sources: Record<SourceRef, string>;
  /** SHA-256 of the stretch's material (see `fingerprintMaterial`). */
  digest: string;
}

export interface CheckedAnswer extends ListenAnswer {
  kind: QuestionKind;
  ask: string;
  expect: 'yes' | 'no';
  /** The verdict read as yes, no or unclear. */
  reading: VerdictReading;
  /** The reading is what the performance should get. Unclear never agrees. */
  agrees: boolean;
  lines: string[];
}

export interface ListeningResult {
  /** Always true: the listening check filters out obvious failures; it never approves a take. */
  filterOnly: true;
  listener: string;
  model: string;
  /** The stretch of the cut the clip covered. */
  clip: { from: number; to: number };
  canHearAudio: boolean;
  answers: CheckedAnswer[];
  fingerprint: CheckFingerprint;
  /** ISO time it was heard. */
  heardAt: string;
}

export interface CheckFile {
  format: typeof CHECK_FORMAT;
  measured: MeasuredCheck & {
    /** By line id, what each line's measurements were taken from. */
    fingerprints: { lines: Record<string, CheckFingerprint>; performances: Record<string, CheckFingerprint> };
  };
  /** By performance id. */
  listening: Record<string, ListeningResult>;
}

/** The answers checked against what each question expects. */
export function checkAnswers(questions: readonly ListenQuestion[], answers: readonly ListenAnswer[]): CheckedAnswer[] {
  return questions.map((q) => {
    const given = answers.find((x) => x.id === q.id);
    const a = given ?? { id: q.id, verdict: '(no answer)', confidence: 0, heard: '', why: 'the listener gave no answer to this question' };
    const reading = given ? readVerdict(a.verdict) : 'unclear';
    return { ...a, kind: q.kind, ask: q.ask, expect: q.expect, reading, agrees: reading === q.expect, lines: q.lines };
  });
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with sorted keys and without labels and absolute paths, so the same edit always reads the same. */
function stable(value: unknown): Json {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'label' || key === 'path') continue;
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = stable(v);
    }
    return out;
  }
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  return value as Json;
}

/** The source refs a timeline item plays (or labels), as written. */
function refsOf(item: TimelineItem): SourceRef[] {
  const refs: SourceRef[] = [];
  const add = (src: unknown): void => {
    if (typeof src === 'object' && src !== null && 'ref' in src && typeof (src as { ref: unknown }).ref === 'string') refs.push((src as { ref: string }).ref);
  };
  if (item.kind === 'segment') {
    add(item.src);
    add(item.audio?.src);
  } else if (item.kind === 'line') {
    if (item.audio.kind === 'file') add(item.audio.src);
  } else if (item.kind === 'music' || item.kind === 'sfx') {
    add(item.src);
    for (const part of item.parts ?? []) add(part.src);
  }
  return refs;
}

/**
 * What a stretch of the cut is made of, as stable JSON: the items heard there
 * (segments and lines, and with `mix` music and sound effects too), the
 * method and `extra` (the questions, the thresholds). Its SHA-256 is a
 * fingerprint's digest; the refs are the sources whose files it hashes.
 */
export function fingerprintMaterial(timeline: Timeline, from: number, to: number, options: { mix?: boolean; extra?: unknown } = {}): { material: string; refs: SourceRef[] } {
  const kinds = new Set(options.mix ? ['segment', 'line', 'music', 'sfx'] : ['segment', 'line']);
  const items = timeline.items.filter((i) => kinds.has(i.kind) && i.end > from + EPS && i.start < to - EPS);
  const refs = [...new Set(items.flatMap(refsOf))].sort();
  const material = JSON.stringify(stable({ method: MEASURE_METHOD, from, to, items, mix: options.mix === true ? timeline.filters.mix : [], extra: options.extra ?? null }));
  return { material, refs };
}

/** Where a fingerprint no longer matches: null when it does. */
export function fingerprintChange(stored: CheckFingerprint, current: CheckFingerprint): string | null {
  if (stored.digest !== current.digest || stored.from !== current.from || stored.to !== current.to) return 'the cut changed there';
  for (const [ref, sha] of Object.entries(current.sources)) {
    if (stored.sources[ref] !== sha) return `${ref} changed`;
  }
  return null;
}

/** Checks parsed JSON has a check file's shape (its format and its three parts); the measurements are taken as written. */
export function parseCheckFile(json: unknown): { ok: true; value: CheckFile } | { ok: false; message: string } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, message: 'expected an object' };
  const o = json as Record<string, unknown>;
  if (o.format !== CHECK_FORMAT) return { ok: false, message: `format: expected "${CHECK_FORMAT}"` };
  const measured = o.measured as Record<string, unknown> | undefined;
  if (typeof measured !== 'object' || measured === null || !Array.isArray(measured.lines) || !Array.isArray(measured.performances)) {
    return { ok: false, message: 'measured: expected { lines, performances, … }' };
  }
  if (typeof o.listening !== 'object' || o.listening === null || Array.isArray(o.listening)) return { ok: false, message: 'listening: expected an object' };
  return { ok: true, value: json as CheckFile };
}

/** The check file as pretty JSON; the same content always gives the same bytes. */
export function serializeCheckFile(file: CheckFile): string {
  const ordered = {
    format: file.format,
    measured: file.measured,
    listening: Object.fromEntries(Object.keys(file.listening).sort().map((k) => [k, file.listening[k]])),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
