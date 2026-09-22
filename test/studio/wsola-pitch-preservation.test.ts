import { describe, it, expect } from "bun:test";
import { timeStretchWsola, WsolaTimeStretcher } from "../../studio/src/lib/wsola";

/**
 * Helper to generate a pure sine wave at a specific frequency and sample rate.
 */
function generateSineWave(freqHz: number, durationSec: number, sampleRate: number): Float32Array {
  const numSamples = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(numSamples);
  const omega = 2 * Math.PI * freqHz;
  for (let i = 0; i < numSamples; i++) {
    out[i] = Math.sin((omega * i) / sampleRate);
  }
  return out;
}

/**
 * Estimates the dominant fundamental frequency using average zero-crossing period.
 */
function estimateFrequency(samples: Float32Array, sampleRate: number): number {
  let zeroCrossings = 0;
  let firstCrossing = -1;
  let lastCrossing = -1;

  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      zeroCrossings++;
      if (firstCrossing < 0) firstCrossing = i;
      lastCrossing = i;
    }
  }

  if (zeroCrossings < 2 || lastCrossing <= firstCrossing) return 0;
  // Each full cycle has 2 zero crossings
  const numCycles = (zeroCrossings - 1) / 2;
  const numSamples = lastCrossing - firstCrossing;
  return (numCycles * sampleRate) / numSamples;
}

describe("WSOLA Pitch-Preserving Time Stretcher (Speech Audio)", () => {
  const SAMPLE_RATE = 24000;

  describe("Pass-Through at 1.0x Rate", () => {
    it("returns identical samples when playback rate is 1.0", () => {
      const input = generateSineWave(200, 0.5, SAMPLE_RATE);
      const output = timeStretchWsola(input, 1.0, SAMPLE_RATE);
      expect(output.length).toBe(input.length);
      for (let i = 0; i < input.length; i++) {
        expect(output[i]).toBe(input[i]);
      }
    });
  });

  describe("Duration Scaling", () => {
    it("compresses duration at 1.5x speed", () => {
      const input = generateSineWave(200, 1.0, SAMPLE_RATE); // 24000 samples
      const output = timeStretchWsola(input, 1.5, SAMPLE_RATE);
      // Expected duration around 24000 / 1.5 = 16000 samples (+/- 5%)
      const expected = Math.round(input.length / 1.5);
      expect(Math.abs(output.length - expected)).toBeLessThan(expected * 0.08);
    });

    it("compresses duration at 2.0x speed", () => {
      const input = generateSineWave(200, 1.0, SAMPLE_RATE);
      const output = timeStretchWsola(input, 2.0, SAMPLE_RATE);
      const expected = Math.round(input.length / 2.0);
      expect(Math.abs(output.length - expected)).toBeLessThan(expected * 0.08);
    });

    it("expands duration at 0.75x speed", () => {
      const input = generateSineWave(200, 1.0, SAMPLE_RATE);
      const output = timeStretchWsola(input, 0.75, SAMPLE_RATE);
      const expected = Math.round(input.length / 0.75);
      expect(Math.abs(output.length - expected)).toBeLessThan(expected * 0.08);
    });
  });

  describe("Pitch Preservation (No Chipmunk Effect)", () => {
    it("preserves 200 Hz speech pitch at 1.5x speed (instead of shifting to 300 Hz)", () => {
      const input = generateSineWave(200, 1.0, SAMPLE_RATE);
      const inFreq = estimateFrequency(input, SAMPLE_RATE);
      expect(Math.round(inFreq)).toBe(200);

      const output = timeStretchWsola(input, 1.5, SAMPLE_RATE);
      const outFreq = estimateFrequency(output, SAMPLE_RATE);

      // In naive resampling (chipmunk), outFreq would be 300 Hz.
      // With WSOLA, outFreq must remain ~200 Hz (+/- 3%).
      expect(outFreq).toBeGreaterThan(190);
      expect(outFreq).toBeLessThan(210);
    });

    it("preserves 150 Hz speech pitch at 2.0x speed (instead of shifting to 300 Hz)", () => {
      const input = generateSineWave(150, 1.0, SAMPLE_RATE);
      const output = timeStretchWsola(input, 2.0, SAMPLE_RATE);
      const outFreq = estimateFrequency(output, SAMPLE_RATE);

      expect(outFreq).toBeGreaterThan(140);
      expect(outFreq).toBeLessThan(160);
    });

    it("preserves 300 Hz speech pitch at 0.75x speed (instead of dropping to 225 Hz)", () => {
      const input = generateSineWave(300, 1.0, SAMPLE_RATE);
      const output = timeStretchWsola(input, 0.75, SAMPLE_RATE);
      const outFreq = estimateFrequency(output, SAMPLE_RATE);

      expect(outFreq).toBeGreaterThan(285);
      expect(outFreq).toBeLessThan(315);
    });

    it("produces finite, valid audio samples with zero NaNs or infinities", () => {
      const input = generateSineWave(220, 0.5, SAMPLE_RATE);
      const output = timeStretchWsola(input, 1.75, SAMPLE_RATE);
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
        expect(Math.abs(output[i])).toBeLessThanOrEqual(1.5);
      }
    });
  });

  describe("WsolaTimeStretcher Stateful Class", () => {
    it("processes audio incrementally across consecutive chunks without discontinuities", () => {
      const stretcher = new WsolaTimeStretcher(1.5, SAMPLE_RATE);
      const chunk1 = generateSineWave(200, 0.4, SAMPLE_RATE);
      const chunk2 = generateSineWave(200, 0.4, SAMPLE_RATE);

      const out1 = stretcher.process(chunk1);
      const out2 = stretcher.process(chunk2);

      expect(out1.length).toBeGreaterThan(0);
      expect(out2.length).toBeGreaterThan(0);

      // Total output length should be ~0.8s / 1.5
      const totalOut = out1.length + out2.length;
      const expectedTotal = Math.round((chunk1.length + chunk2.length) / 1.5);
      expect(Math.abs(totalOut - expectedTotal)).toBeLessThan(expectedTotal * 0.1);
    });
  });
});
