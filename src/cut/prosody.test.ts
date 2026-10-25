import { describe, expect, it } from 'bun:test';
import { countSyllables, decimate, gatedLoudness, kWeight, median, quantile, semitones, shortLoudness, yinPitch } from './prosody.js';

const SR = 48_000;

function sine(hz: number, seconds: number, amplitude = 1, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

/** A voice-like tone: a fundamental and falling harmonics, the second louder than the first, as in many voices. */
function voiced(hz: number, seconds: number, sr: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const amps = [0.5, 0.7, 0.4, 0.25, 0.15, 0.1];
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (const [k, a] of amps.entries()) v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / sr);
    out[i] = 0.2 * v;
  }
  return out;
}

describe('BS.1770 loudness', () => {
  it('reads a full-scale 997 Hz sine as -3.01 LUFS (mono), and 20 dB down as -23.01', () => {
    const full = kWeight({ samples: sine(997, 3), sampleRate: SR });
    expect(gatedLoudness(full, SR, 0, 3)).toBeCloseTo(-3.01, 1);
    const quiet = kWeight({ samples: sine(997, 3, 0.1), sampleRate: SR });
    expect(gatedLoudness(quiet, SR, 0, 3)).toBeCloseTo(-23.01, 1);
    expect(shortLoudness(quiet, SR, 1, 1.3)).toBeCloseTo(-23.01, 1);
  });

  it('measures a stretch shorter than one block whole, and calls silence null', () => {
    const w = kWeight({ samples: sine(997, 1, 0.1), sampleRate: SR });
    expect(gatedLoudness(w, SR, 0.5, 0.75)).toBeCloseTo(-23.01, 1);
    const silent = kWeight({ samples: new Float32Array(SR), sampleRate: SR });
    expect(gatedLoudness(silent, SR, 0, 1)).toBeNull();
    expect(shortLoudness(silent, SR, 0, 1)).toBeNull();
  });

  it('gates out the quiet blocks of a stretch with a loud part', () => {
    const samples = new Float32Array(4 * SR);
    samples.set(sine(997, 2, 0.1), 0);
    samples.set(sine(997, 2, 0.001), 2 * SR); // 40 dB down: below the relative gate
    expect(gatedLoudness(kWeight({ samples, sampleRate: SR }), SR, 0, 4)).toBeCloseTo(-23.01, 0);
  });
});

describe('YIN pitch', () => {
  it('finds the fundamental of a voice-like tone, not its louder second harmonic', () => {
    for (const hz of [95, 120, 210, 330]) {
      const audio = decimate({ samples: voiced(hz, 1, SR), sampleRate: SR }, 3);
      expect(audio.sampleRate).toBe(16_000);
      const track = yinPitch(audio, 0.05, 0.95).map((f) => f.hz).filter((x): x is number => x !== null);
      expect(track.length).toBeGreaterThan(80);
      expect(Math.abs(median(track) - hz) / hz).toBeLessThan(0.01);
    }
  });

  it('calls noise and silence unvoiced', () => {
    let seed = 1;
    const noise = new Float32Array(16_000).map(() => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return (seed / 4294967296 - 0.5) * 0.2;
    });
    const voicedNoise = yinPitch({ samples: noise, sampleRate: 16_000 }, 0.05, 0.95).filter((f) => f.hz !== null);
    expect(voicedNoise.length).toBeLessThan(10);
    expect(yinPitch({ samples: new Float32Array(16_000), sampleRate: 16_000 }, 0.05, 0.95).every((f) => f.hz === null)).toBe(true);
  });

  it('counts semitones and quantiles', () => {
    expect(semitones(200, 100)).toBeCloseTo(12, 6);
    expect(semitones(100 * 2 ** (3 / 12), 100)).toBeCloseTo(3, 6);
    expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4, 6);
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe('syllables', () => {
  it('estimates syllables well enough to compare speech rates', () => {
    expect(['the', 'car', 'personally', 'inspected', 'sale', 'little', 'free', 'wheels', '99'].map(countSyllables)).toEqual([1, 1, 4, 3, 1, 2, 1, 1, 1]);
  });
});
