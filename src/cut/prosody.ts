/**
 * Measuring speech in PCM audio: loudness (ITU-R BS.1770 K-weighted, in
 * LUFS), pitch (a YIN detector) and a syllable estimate for speech rate
 * (frame levels are onset.ts's `frameLevels`). Pure
 * functions over samples; nothing here touches files. `mdmedia cut check`
 * uses them on a render of the cut's dialogue (see check.ts).
 */

import type { PcmAudio } from './onset.js';

// ---------------------------------------------------------------------------
// Loudness

/** A biquad, `b0 + b1 z⁻¹ + b2 z⁻²` over `1 + a1 z⁻¹ + a2 z⁻²`. */
interface Biquad {
  b: [number, number, number];
  a: [number, number];
}

/** BS.1770's two K-weighting stages at any sample rate (the analog prototypes libebur128 uses). */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
  return [shelf, highpass];
}

function filter(input: Float32Array | Float64Array, f: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const [b0, b1, b2] = f.b;
  const [a1, a2] = f.a;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** The signal through BS.1770's K-weighting. */
export function kWeight(audio: PcmAudio): Float64Array {
  const [shelf, highpass] = kWeightingFilters(audio.sampleRate);
  return filter(filter(audio.samples, shelf), highpass);
}

function meanSquare(x: Float64Array | Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return to > from ? sum / (to - from) : 0;
}

/** Mono loudness of a mean square of K-weighted samples, in LUFS. */
function lufs(ms: number): number {
  return -0.691 + 10 * Math.log10(ms);
}

const ABSOLUTE_GATE = -70;

/**
 * Gated loudness (BS.1770-4, mono) of K-weighted samples from `from` to `to`
 * seconds: 400 ms blocks every 100 ms, gated at -70 LUFS and then 10 LU below
 * their mean. A stretch shorter than one block is measured whole. Null when it
 * is silent.
 */
export function gatedLoudness(weighted: Float64Array, sampleRate: number, from: number, to: number): number | null {
  const start = Math.max(0, Math.round(from * sampleRate));
  const end = Math.min(weighted.length, Math.round(to * sampleRate));
  if (end <= start) return null;
  const block = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  const blocks: number[] = [];
  if (end - start <= block) blocks.push(meanSquare(weighted, start, end));
  else for (let b = start; b + block <= end; b += step) blocks.push(meanSquare(weighted, b, b + block));
  const loud = blocks.filter((ms) => ms > 0 && lufs(ms) > ABSOLUTE_GATE);
  if (loud.length === 0) return null;
  const relative = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const kept = loud.filter((ms) => lufs(ms) > relative);
  return lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** Ungated loudness of K-weighted samples over a short stretch (a word), in LUFS, or null when silent. */
export function shortLoudness(weighted: Float64Array, sampleRate: number, from: number, to: number): number | null {
  const start = Math.max(0, Math.round(from * sampleRate));
  const end = Math.min(weighted.length, Math.round(to * sampleRate));
  const ms = meanSquare(weighted, start, end);
  if (!(ms > 0)) return null;
  const value = lufs(ms);
  return value > ABSOLUTE_GATE ? value : null;
}

// ---------------------------------------------------------------------------
// Pitch

/** Halves (or more) the sample rate by a whole factor, after a windowed-sinc low-pass. */
export function decimate(audio: PcmAudio, factor: number): PcmAudio {
  if (factor <= 1) return audio;
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.9 / (2 * factor);
  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  for (let i = 0; i < taps; i++) kernel[i] /= sum;
  const input = audio.samples;
  const out = new Float32Array(Math.floor(input.length / factor));
  for (let o = 0; o < out.length; o++) {
    const c = o * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - half;
      if (j >= 0 && j < input.length) acc += input[j] * kernel[i];
    }
    out[o] = acc;
  }
  return { sampleRate: audio.sampleRate / factor, samples: out };
}

export interface PitchOptions {
  /** Lowest and highest pitch to find, Hz. Default 60–500. */
  minHz?: number;
  maxHz?: number;
  /** YIN's threshold on the cumulative mean normalized difference. Default 0.15. */
  threshold?: number;
  /** A frame whose best dip is above this is unvoiced. Default 0.3. */
  voicing?: number;
  /** Seconds between frames. Default 0.01. */
  hop?: number;
}

/** One pitch frame: its centre in seconds from the audio's start, and its pitch in Hz, or null when unvoiced. */
export interface PitchFrame {
  t: number;
  hz: number | null;
}

/**
 * YIN pitch tracking (de Cheveigné and Kawahara, 2002) over `from`–`to`
 * seconds: the cumulative mean normalized difference of each frame, its first
 * dip under the threshold (else its lowest, if voiced enough), refined by a
 * parabola. Works best at 16 kHz.
 */
export function yinPitch(audio: PcmAudio, from: number, to: number, options: PitchOptions = {}): PitchFrame[] {
  const sr = audio.sampleRate;
  const minHz = options.minHz ?? 60;
  const maxHz = options.maxHz ?? 500;
  const threshold = options.threshold ?? 0.15;
  const voicing = options.voicing ?? 0.3;
  const hop = options.hop ?? 0.01;
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.ceil(sr / minHz);
  const window = tauMax;
  const x = audio.samples;
  const d = new Float64Array(tauMax + 2);
  const frames: PitchFrame[] = [];
  for (let t = Math.max(from, (window + tauMax) / 2 / sr); t <= to; t += hop) {
    const start = Math.round(t * sr) - Math.floor((window + tauMax) / 2);
    if (start < 0 || start + window + tauMax + 1 >= x.length) {
      frames.push({ t, hz: null });
      continue;
    }
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let sum = 0;
      for (let j = 0; j < window; j++) {
        const diff = x[start + j] - x[start + j + tau];
        sum += diff * diff;
      }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let low = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[low]) low = tau;
      if (d[low] < voicing) best = low;
    }
    if (best < 0) {
      frames.push({ t, hz: null });
      continue;
    }
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const period = best + Math.max(-1, Math.min(1, shift));
    frames.push({ t, hz: sr / period });
  }
  return frames;
}

/** Semitones from `ref` Hz. */
export function semitones(hz: number, ref = 100): number {
  return 12 * Math.log2(hz / ref);
}

/** The value at fraction `q` (0–1) of a list, linearly between neighbours. */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

// ---------------------------------------------------------------------------
// Speech rate

/**
 * An estimate of a word's syllables: its runs of vowels (with y), less a
 * silent final e, at least one. Good enough to compare speech rates, not to
 * hyphenate.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return /\p{N}/u.test(word) ? 1 : 0;
  let groups = (w.match(/[aeiouy]+/g) ?? []).length;
  // A final e after a consonant is usually silent ("sale"), except in a final -le ("little").
  if (groups > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) groups--;
  return Math.max(1, groups);
}
