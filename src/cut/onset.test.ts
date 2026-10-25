import { describe, expect, it } from 'bun:test';
import {
  MAX_SNAP,
  bandPass,
  decodeWav,
  frameLevels,
  measureAlignerAudio,
  measureSpeechOnset,
  onsetFromLevels,
  snapFirstWord,
  type AlignedWord,
  type OnsetMeasurement,
  type PcmAudio,
} from './index.js';

const RATE = 16_000;

/** A deterministic pseudo-random source, so the noise is the same every run. */
function random(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Builds `seconds` of audio from a per-sample function of time. */
function audio(seconds: number, sample: (t: number) => number): PcmAudio {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = sample(i / RATE);
  return { samples, sampleRate: RATE };
}

/** A speech-band "voice": two tones at `gain`, from `from` seconds to `to`. */
const voice = (t: number, from: number, to: number, gain = 0.3): number =>
  t >= from && t < to ? gain * (0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.4 * Math.sin(2 * Math.PI * 1200 * t)) : 0;

/** Packs samples as a mono 16-bit PCM WAV, as `extractWindow` writes them. */
function wav(pcm: PcmAudio): Uint8Array {
  const data = pcm.samples.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, data, true);
  pcm.samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return bytes;
}

const words = (first: number): AlignedWord[] => [
  { text: 'Then', start: first, end: first + 0.12, loss: 0.6 },
  { text: 'we', start: first + 0.16, end: first + 0.3 },
];

describe('measuring where speech starts', () => {
  it('finds a tone burst after silence, to the 10 ms frame', () => {
    const measured = measureSpeechOnset(audio(1, (t) => voice(t, 0.06, 0.8)));
    expect(measured.onset).toBe(0.06);
    // Digital silence sits at the bottom of the scale; the threshold is then 30 dB under the burst's peak.
    expect(measured.floor).toBe(-120);
    expect(measured.threshold).toBeCloseTo(measured.peak - 30, 6);
  });

  it('finds a burst over steady noise, with the threshold set by the noise it measured', () => {
    const noise = random(7);
    // White noise about 18 dB under the voice, like Rick's car.
    const measured = measureSpeechOnset(audio(1.2, (t) => 0.04 * (noise() * 2 - 1) + voice(t, 0.31, 1)));
    expect(measured.onset).not.toBeNull();
    expect(Math.abs(measured.onset! - 0.31)).toBeLessThanOrEqual(0.011);
    expect(measured.floor).toBeGreaterThan(-50);
    expect(measured.floor).toBeLessThan(-30);
    expect(measured.threshold).toBeCloseTo(measured.floor + 7, 6);
  });

  it("doesn't take a click before the speech for its onset", () => {
    const click = (t: number): number => (t >= 0.02 && t < 0.024 ? 0.8 * Math.sin(2 * Math.PI * 2000 * t) : 0);
    const measured = measureSpeechOnset(audio(1, (t) => click(t) + voice(t, 0.15, 0.8)));
    expect(measured.onset).toBe(0.15);
  });

  it('needs a run of three frames above the threshold', () => {
    const levels = [-90, -90, -20, -20, -90, -90, -20, -20, -20, -20, -90, -90];
    expect(onsetFromLevels(levels).onset).toBe(0.06);
    expect(onsetFromLevels([-90, -90, -20, -20, -90]).onset).toBeNull();
  });

  it("doesn't mistake the start of a window cut out of steady noise for speech", () => {
    const noise = random(3);
    const pcm = audio(0.6, () => 0.05 * (noise() * 2 - 1));
    const levels = frameLevels(bandPass(pcm.samples, RATE), RATE);
    const measured = onsetFromLevels(levels);
    // Its first frame doesn't stand out from the rest (the filters start up on a mirrored copy of the start).
    expect(levels[0]).toBeLessThan(measured.threshold);
  });

  it('reads the 16-bit mono WAV that ffmpeg extracts', () => {
    const pcm = audio(0.5, (t) => voice(t, 0.1, 0.4));
    const decoded = decodeWav(wav(pcm));
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.samples.length).toBe(pcm.samples.length);
    expect(measureAlignerAudio({ bytes: wav(pcm), sampleRate: RATE }).onset).toBe(0.1);
    expect(() => decodeWav(new TextEncoder().encode('not audio'))).toThrow('not a WAV file');
  });
});

describe("snapping a line's first word to the onset", () => {
  const measured = (onset: number | null): OnsetMeasurement => ({ onset, floor: -62.34, threshold: -50, peak: -20 });

  it('moves only the first word earlier to the onset, keeping every end, and records what it did', () => {
    // The window starts 2.65 s into the take; speech starts 0.13 s in, the aligner said 0.18.
    const { words: snapped, snap } = snapFirstWord(words(2.83), measured(0.13), 2.65);
    expect(snapped).toEqual([{ text: 'Then', start: 2.78, end: 2.95, loss: 0.6 }, { text: 'we', start: 2.99, end: 3.13 }]);
    expect(snap).toEqual({ aligned: 2.83, start: 2.78, onset: 2.78, floor: -62.3 });
  });

  it('snaps an onset exactly the limit early', () => {
    expect(snapFirstWord(words(0.2), measured(0.2 - MAX_SNAP), 0).words[0].start).toBe(0.1);
  });

  it("doesn't snap an onset more than 0.10 s early", () => {
    const pcm = audio(1, (t) => voice(t, 0.05, 0.8));
    const onset = measureSpeechOnset(pcm);
    expect(onset.onset).toBe(0.05);
    const { words: kept, snap } = snapFirstWord(words(0.17), onset, 0);
    expect(kept[0].start).toBe(0.17);
    expect(snap).toMatchObject({ aligned: 0.17, start: 0.17, onset: 0.05 });
  });

  it('never moves a start later, and keeps it when no onset was found', () => {
    expect(snapFirstWord(words(0.1), measured(0.14), 0).words[0].start).toBe(0.1);
    expect(snapFirstWord(words(0.1), measured(0.1), 0).words[0].start).toBe(0.1);
    expect(snapFirstWord(words(0.1), measured(null), 0)).toEqual({ words: words(0.1), snap: { aligned: 0.1, start: 0.1, onset: null, floor: -62.3 } });
  });

  it('has nothing to snap on a line with no words', () => {
    expect(snapFirstWord([], measured(0.05), 0)).toEqual({ words: [], snap: null });
  });
});
