import type { AlignedWord, AlignerAudio, FirstWordSnap } from './words.js';

/**
 * Where speech starts in a line's audio window, measured from the audio
 * itself, so a line's first word can be moved back to it. Forced alignment
 * times a clean TTS line's first word 0.02–0.05 s late (its times fall on a
 * 20 ms grid), while its line endings are right; this corrects the start and
 * nothing else. Pure: it works on decoded samples and touches no files.
 */

/**
 * The snapping method's name and version, kept in each words-file fingerprint.
 * Change it whenever the method's results change, so stored lines realign.
 */
export const SNAP_METHOD = 'speech-onset@1';

/** Frame hop (and frame length), in seconds. */
export const ONSET_HOP = 0.01;
/** The speech band, in Hz: 300–3400, the telephone band. */
export const SPEECH_BAND = { low: 300, high: 3400 } as const;
/** The window's background level is this percentile of its frame levels. */
export const FLOOR_PERCENTILE = 0.1;
/** Speech is at least this many dB above the background... */
export const FLOOR_MARGIN_DB = 7;
/** ...and never more than this many dB below the window's loudest frame. */
export const PEAK_RANGE_DB = 30;
/** An onset starts a run of at least this many frames above the threshold (30 ms), so a click doesn't count. */
export const MIN_RUN_FRAMES = 3;
/** The first word moves earlier by at most this much, in seconds. */
export const MAX_SNAP = 0.1;

/** The level given to a frame of digital silence, in dBFS. */
const SILENCE_DB = -120;
const EPS = 1e-6;

export interface PcmAudio {
  /** Mono samples, -1 to 1. */
  samples: Float32Array;
  sampleRate: number;
}

/** Decodes a PCM WAV (16-bit integer or 32-bit float), mixing its channels down to mono. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format: { code: number; channels: number; sampleRate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let code = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true);
      format = { code, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data comes before its format');
      const { code, channels, sampleRate, bits } = format;
      const pcm16 = code === 1 && bits === 16;
      const float32 = code === 3 && bits === 32;
      if (!pcm16 && !float32) throw new Error(`unsupported WAV encoding (format ${code}, ${bits}-bit)`);
      const step = (bits / 8) * channels;
      // ffmpeg writes a placeholder size when it streams; trust the file's length then.
      const end = Math.min(bytes.length, size === 0xffffffff || size === 0 ? bytes.length : body + size);
      const frames = Math.floor((end - body) / step);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const at = body + i * step + c * (bits / 8);
          sum += pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
        }
        samples[i] = sum / channels;
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data');
}

/** RBJ biquad coefficients, normalised so a0 = 1. */
function biquad(kind: 'lowpass' | 'highpass', frequency: number, sampleRate: number): [number, number, number, number, number] {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = kind === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = kind === 'lowpass' ? b1 / 2 : -b1 / 2;
  return [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

function runBiquad(input: Float64Array, [b0, b1, b2, a1, a2]: [number, number, number, number, number]): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

/**
 * The samples band-passed to `low`–`high` Hz: two Butterworth high-pass and
 * two low-pass sections (4th order each way). The start is mirrored before
 * filtering, so a window cut out of steady noise doesn't begin with the
 * filters' own start-up thump.
 */
export function bandPass(samples: Float32Array, sampleRate: number, low = SPEECH_BAND.low, high = SPEECH_BAND.high): Float64Array {
  const pad = Math.min(samples.length - 1, Math.round(sampleRate * 0.05));
  let signal: Float64Array = new Float64Array(pad + samples.length);
  for (let i = 0; i < pad; i++) signal[i] = samples[pad - i];
  signal.set(samples, pad);
  const nyquist = sampleRate / 2;
  const sections: Array<[number, number, number, number, number]> = [];
  if (low > 0 && low < nyquist) sections.push(biquad('highpass', low, sampleRate), biquad('highpass', low, sampleRate));
  if (high > 0 && high < nyquist) sections.push(biquad('lowpass', high, sampleRate), biquad('lowpass', high, sampleRate));
  for (const section of sections) signal = runBiquad(signal, section);
  return signal.subarray(pad);
}

/** Each `hop`-second frame's RMS level in dBFS; digital silence is -120. A partial last frame is dropped. */
export function frameLevels(samples: ArrayLike<number>, sampleRate: number, hop = ONSET_HOP): number[] {
  const size = Math.max(1, Math.round(sampleRate * hop));
  const levels: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / size);
    levels.push(rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB);
  }
  return levels;
}

export interface OnsetMeasurement {
  /** Seconds from the window's start to the first frame of sustained speech, or null when none was found. */
  onset: number | null;
  /** The window's background level, dBFS. */
  floor: number;
  /** The level a frame needed to count as speech, dBFS. */
  threshold: number;
  /** The window's loudest frame, dBFS. */
  peak: number;
}

/**
 * Finds the onset in a window's frame levels. The window sets its own
 * threshold: a margin above its background level (a low percentile of its
 * frames), but never more than `PEAK_RANGE_DB` below its loudest frame, so
 * near-silent TTS and a take over steady road noise both work with no
 * per-source setting. The onset is the first frame above the threshold that
 * starts a run of at least `MIN_RUN_FRAMES`.
 */
export function onsetFromLevels(levels: readonly number[], hop = ONSET_HOP): OnsetMeasurement {
  if (levels.length === 0) return { onset: null, floor: SILENCE_DB, threshold: SILENCE_DB, peak: SILENCE_DB };
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(FLOOR_PERCENTILE * (sorted.length - 1))];
  const peak = sorted[sorted.length - 1];
  const threshold = Math.max(floor + FLOOR_MARGIN_DB, peak - PEAK_RANGE_DB);
  let onset: number | null = null;
  let run = 0;
  for (let i = 0; i < levels.length; i++) {
    run = levels[i] > threshold ? run + 1 : 0;
    if (run === MIN_RUN_FRAMES) {
      onset = Math.round((i - MIN_RUN_FRAMES + 1) * hop * 1e6) / 1e6;
      break;
    }
  }
  return { onset, floor, threshold, peak };
}

/** Measures where speech starts in a window's audio, in the speech band at a `ONSET_HOP` hop. */
export function measureSpeechOnset(audio: PcmAudio): OnsetMeasurement {
  return onsetFromLevels(frameLevels(bandPass(audio.samples, audio.sampleRate), audio.sampleRate, ONSET_HOP), ONSET_HOP);
}

/** Decodes an aligner's WAV and measures its onset. Throws when the audio isn't a PCM WAV. */
export function measureAlignerAudio(audio: AlignerAudio): OnsetMeasurement {
  return measureSpeechOnset(decodeWav(audio.bytes));
}

function round3(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

/**
 * Moves a line's first word (source clock) earlier to the measured onset,
 * when the onset is before the aligner's start and no more than `MAX_SNAP`
 * before it. It never moves the start later or before the window, and leaves
 * every other word, and every end, as aligned. Returns the words and the
 * record the words file keeps; with no words there is nothing to snap.
 */
export function snapFirstWord(
  words: readonly AlignedWord[],
  measured: OnsetMeasurement,
  windowStart: number,
): { words: AlignedWord[]; snap: FirstWordSnap | null } {
  if (words.length === 0) return { words: [...words], snap: null };
  const [first, ...rest] = words;
  const onset = measured.onset === null ? null : round3(windowStart + measured.onset);
  const early = onset === null ? 0 : first.start - onset;
  const start = onset !== null && early > EPS && early <= MAX_SNAP + EPS ? Math.max(round3(windowStart), onset) : first.start;
  const snap: FirstWordSnap = { aligned: first.start, start, onset, floor: Math.round(measured.floor * 10) / 10 };
  return { words: [{ ...first, start }, ...rest], snap };
}
