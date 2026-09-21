import { describe, expect, it } from 'bun:test';

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.5;
const SPEED_STEP = 0.05;

function roundSpeed(val: number): number {
  return Math.round(val * 100) / 100;
}

function formatSpeed(val: number): string {
  return `${roundSpeed(val).toFixed(2)}×`;
}

function clampSpeed(value: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, roundSpeed(value)));
}

describe('Granular Playback Speed Configuration', () => {
  describe('Formatting & Rounding (Fixed-width / Zero Layout Shift)', () => {
    it('formats integers with fixed two decimals to prevent layout shift', () => {
      expect(formatSpeed(1)).toBe('1.00×');
      expect(formatSpeed(2)).toBe('2.00×');
    });

    it('formats single decimal values with fixed two decimals', () => {
      expect(formatSpeed(1.5)).toBe('1.50×');
      expect(formatSpeed(0.8)).toBe('0.80×');
      expect(formatSpeed(2.5)).toBe('2.50×');
    });

    it('formats two-decimal granular values cleanly', () => {
      expect(formatSpeed(1.25)).toBe('1.25×');
      expect(formatSpeed(1.15)).toBe('1.15×');
      expect(formatSpeed(0.95)).toBe('0.95×');
    });

    it('prevents IEEE 754 floating point drift and preserves fixed width', () => {
      const drifted = 1.05 + 0.05; // 1.1000000000000001 in raw JS
      expect(roundSpeed(drifted)).toBe(1.1);
      expect(formatSpeed(drifted)).toBe('1.10×');

      const drifted2 = 1.35 - 0.05; // 1.3000000000000003 in raw JS
      expect(roundSpeed(drifted2)).toBe(1.3);
      expect(formatSpeed(drifted2)).toBe('1.30×');
    });
  });

  describe('Clamping & Boundaries', () => {
    it('clamps below MIN_SPEED (0.5×)', () => {
      expect(clampSpeed(0.2)).toBe(0.5);
      expect(clampSpeed(-1)).toBe(0.5);
      expect(clampSpeed(0.49)).toBe(0.5);
    });

    it('clamps above MAX_SPEED (2.5×)', () => {
      expect(clampSpeed(2.8)).toBe(2.5);
      expect(clampSpeed(3.0)).toBe(2.5);
      expect(clampSpeed(2.51)).toBe(2.5);
    });

    it('accepts valid granular values in range', () => {
      expect(clampSpeed(1.15)).toBe(1.15);
      expect(clampSpeed(1.4)).toBe(1.4);
    });
  });

  describe('Presets & Stepper Increments', () => {
    it('ensures all SPEED_PRESETS fall within supported bounds', () => {
      for (const preset of SPEED_PRESETS) {
        expect(preset).toBeGreaterThanOrEqual(MIN_SPEED);
        expect(preset).toBeLessThanOrEqual(MAX_SPEED);
      }
    });

    it('calculates micro-stepper decrements accurately', () => {
      let speed = 1.25;
      speed = clampSpeed(speed - SPEED_STEP);
      expect(speed).toBe(1.2);
      speed = clampSpeed(speed - SPEED_STEP);
      expect(speed).toBe(1.15);
    });

    it('calculates micro-stepper increments accurately', () => {
      let speed = 1.0;
      speed = clampSpeed(speed + SPEED_STEP);
      expect(speed).toBe(1.05);
      speed = clampSpeed(speed + SPEED_STEP);
      expect(speed).toBe(1.1);
    });
  });
});
