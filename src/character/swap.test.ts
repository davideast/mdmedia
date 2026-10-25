import { describe, expect, it } from 'bun:test';
import { frameLevels, type PcmAudio } from '../cut/onset.js';
import { compareSwap, envelopeLag, measureSpeech } from './swap.js';

const SR = 16_000;

/** Bursts of a tone (a "word" each) at these times, with silence between. */
function speech(words: Array<{ start: number; end: number; hz: number; gain?: number }>, seconds = 3): PcmAudio {
  const samples = new Float32Array(seconds * SR);
  for (const w of words) {
    for (let i = Math.round(w.start * SR); i < Math.round(w.end * SR); i++) samples[i] = (w.gain ?? 0.3) * Math.sin((2 * Math.PI * w.hz * i) / SR);
  }
  return { samples, sampleRate: SR };
}

const WORDS = [
  { text: 'What', start: 0.5, end: 0.8 },
  { text: 'a', start: 0.9, end: 1.0 },
  { text: 'win', start: 1.2, end: 1.7 },
];

describe('the voice swap measures', () => {
  it('measure loudness, pitch and pace over the words', () => {
    const m = measureSpeech(speech(WORDS.map((w) => ({ ...w, hz: 150 }))), WORDS);
    expect(m.speech).toEqual({ start: 0.5, end: 1.7 });
    expect(m.words).toBe(3);
    expect(m.rate).toBe(2.5);
    expect(m.pitch?.median).toBeCloseTo(150, 0);
    expect(m.loudness).not.toBeNull();
  });

  it('find the lag between two envelopes', () => {
    const a = speech(WORDS.map((w) => ({ ...w, hz: 150 })));
    const b = speech(WORDS.map((w) => ({ ...w, start: w.start + 0.05, end: w.end + 0.05, hz: 150 })));
    const lag = envelopeLag(frameLevels(a.samples, SR, 0.01), frameLevels(b.samples, SR, 0.01), 0.01);
    expect(lag.lag).toBeCloseTo(0.05, 2);
    expect(lag.correlation).toBeGreaterThan(0.9);
  });

  it('compare before and after: the same words, how far each moved, and how the voice changed', () => {
    const before = speech(WORDS.map((w) => ({ ...w, hz: 150, gain: 0.3 })));
    const after = speech(WORDS.map((w) => ({ ...w, hz: 300, gain: 0.15 })));
    const afterWords = WORDS.map((w, i) => ({ ...w, start: w.start + (i === 2 ? 0.04 : 0.01), end: w.end + 0.01 }));
    const c = compareSwap({ before, after, beforeWords: WORDS, afterWords });
    expect(c.sameWords).toBe(true);
    expect(c.words.map((w) => w.start)).toEqual([0.01, 0.01, 0.04]);
    expect(c.drift).toEqual({ median: 0.01, largest: 0.04, word: 'win' });
    expect(c.envelope.lag).toBe(0);
    expect(c.change.pitch).toBeCloseTo(12, 0);
    expect(c.change.loudness).toBeCloseTo(-6, 0);
    expect(c.change.length).toBe(0);
  });

  it('say when the words differ, and compare no timings', () => {
    const audio = speech([]);
    const c = compareSwap({ before: audio, after: audio, beforeWords: WORDS, afterWords: WORDS.slice(0, 2) });
    expect(c.sameWords).toBe(false);
    expect(c.words).toEqual([]);
    expect(c.drift).toEqual({ median: 0, largest: 0, word: null });
  });
});
