import { frameLevels, type PcmAudio } from '../cut/onset.js';
import { decimate, gatedLoudness, kWeight, median, quantile, semitones, yinPitch } from '../cut/prosody.js';
import type { Word } from '../cut/types.js';

/**
 * The voice swap's measurements, pure: how a line's speech compares before
 * and after it was converted to a character's voice. Words and their timings
 * (from forced alignment of the same text on both), lip-sync drift (each
 * word's start, after minus before, and the lag that best lines up the two
 * loudness envelopes), loudness, pitch and pace. See docs/characters.md.
 */

export interface SpeechMeasure {
  /** First word's start to last word's end, seconds. */
  speech: { start: number; end: number };
  /** Gated BS.1770 loudness over the speech, LUFS. */
  loudness: number | null;
  /** Median voiced pitch, Hz, and the 10th–90th percentile range in semitones. */
  pitch: { median: number; range: number } | null;
  /** Words per second of speech. */
  rate: number | null;
  words: number;
}

export interface WordShift {
  text: string;
  before: { start: number; end: number };
  after: { start: number; end: number };
  /** After minus before, seconds: positive is late. */
  start: number;
  end: number;
}

export interface SwapComparison {
  /** The same words, in the same order, before and after (by forced alignment of the same text, so this compares timings, not recognition). */
  sameWords: boolean;
  words: WordShift[];
  /** Word-start drift, seconds: the median and the largest by size. */
  drift: { median: number; largest: number; word: string | null };
  /** The lag (after relative to before) that best lines up the two loudness envelopes, seconds, and how well (0–1). */
  envelope: { lag: number; correlation: number };
  before: SpeechMeasure;
  after: SpeechMeasure;
  /** After minus before. */
  change: { loudness: number | null; pitch: number | null; pitchRange: number | null; rate: number | null; length: number };
}

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;
const PITCH_RATE = 16_000;
const FRAME = 0.02;

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Loudness, pitch and pace of the speech in `audio`, inside `words` (seconds from its start). */
export function measureSpeech(audio: PcmAudio, words: readonly Word[]): SpeechMeasure {
  if (words.length === 0) return { speech: { start: 0, end: 0 }, loudness: null, pitch: null, rate: null, words: 0 };
  const start = Math.min(...words.map((w) => w.start));
  const end = Math.max(...words.map((w) => w.end));
  const sr = audio.sampleRate;
  const loud = gatedLoudness(kWeight(audio), sr, start, end);
  const low = decimate(audio, Math.max(1, Math.round(sr / PITCH_RATE)));
  const levels = frameLevels(audio.samples, sr, FRAME);
  const hz: number[] = [];
  for (const w of words) {
    if (w.end <= w.start) continue;
    for (const f of yinPitch(low, w.start, w.end)) {
      if (f.hz === null) continue;
      const level = levels[Math.floor(f.t / FRAME)];
      if (level !== undefined && level < -55) continue;
      hz.push(f.hz);
    }
  }
  const pitch = hz.length < 5 ? null : { median: round(median(hz), 1), range: round(semitones(quantile(hz, 0.9), quantile(hz, 0.1)), 1) };
  const seconds = end - start;
  return {
    speech: { start: round(start, 3), end: round(end, 3) },
    loudness: loud === null || !Number.isFinite(loud) ? null : round(loud, 1),
    pitch,
    rate: seconds > 0 ? round(words.length / seconds) : null,
    words: words.length,
  };
}

/** The lag (seconds, `b` relative to `a`) within ±`maxLag` that best correlates two level envelopes (dB frames), and the correlation there. */
export function envelopeLag(a: readonly number[], b: readonly number[], frame: number, maxLag = 0.3): { lag: number; correlation: number } {
  const floor = (xs: readonly number[]) => xs.map((x) => Math.max(x, -60));
  const x = floor(a);
  const y = floor(b);
  const n = Math.min(x.length, y.length);
  const maxShift = Math.round(maxLag / frame);
  let best = { lag: 0, correlation: -Infinity };
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = i + shift;
      if (j < 0 || j >= y.length) continue;
      xs.push(x[i]!);
      ys.push(y[j]!);
    }
    if (xs.length < 10) continue;
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      dx += (xs[i]! - mx) ** 2;
      dy += (ys[i]! - my) ** 2;
    }
    const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
    if (r > best.correlation) best = { lag: shift * frame, correlation: r };
  }
  return { lag: round(best.lag, 3), correlation: round(Math.max(0, best.correlation), 3) };
}

/** Compares a line's speech before and after the swap, from both audios and both alignments of its text. */
export function compareSwap(input: { before: PcmAudio; after: PcmAudio; beforeWords: readonly Word[]; afterWords: readonly Word[] }): SwapComparison {
  const { beforeWords, afterWords } = input;
  const sameWords = beforeWords.length === afterWords.length && beforeWords.every((w, i) => normalize(w.text) === normalize(afterWords[i]!.text));
  const words: WordShift[] = sameWords
    ? beforeWords.map((w, i) => {
        const a = afterWords[i]!;
        return {
          text: w.text,
          before: { start: round(w.start, 3), end: round(w.end, 3) },
          after: { start: round(a.start, 3), end: round(a.end, 3) },
          start: round(a.start - w.start, 3),
          end: round(a.end - w.end, 3),
        };
      })
    : [];
  const shifts = words.map((w) => w.start);
  const largest = words.reduce<WordShift | null>((m, w) => (m === null || Math.abs(w.start) > Math.abs(m.start) ? w : m), null);
  const before = measureSpeech(input.before, beforeWords);
  const after = measureSpeech(input.after, afterWords);
  const diff = (a: number | null | undefined, b: number | null | undefined, places = 2) => (a === null || a === undefined || b === null || b === undefined ? null : round(b - a, places));
  const env = envelopeLag(frameLevels(input.before.samples, input.before.sampleRate, 0.01), frameLevels(input.after.samples, input.after.sampleRate, 0.01), 0.01);
  return {
    sameWords,
    words,
    drift: { median: shifts.length ? round(median(shifts), 3) : 0, largest: largest ? largest.start : 0, word: largest?.text ?? null },
    envelope: env,
    before,
    after,
    change: {
      loudness: diff(before.loudness, after.loudness, 1),
      pitch: before.pitch && after.pitch ? round(semitones(after.pitch.median, before.pitch.median), 1) : null,
      pitchRange: diff(before.pitch?.range, after.pitch?.range, 1),
      rate: diff(before.rate, after.rate),
      length: round(input.after.samples.length / input.after.sampleRate - input.before.samples.length / input.before.sampleRate, 3),
    },
  };
}
