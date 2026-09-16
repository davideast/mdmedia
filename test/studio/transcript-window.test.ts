import { describe, it, expect } from 'bun:test';
import { computeTranscriptWindowStartIdx } from '../../src/tui/components/transcript-pane.js';

describe('Transcript Window Scrolling & Selected Item Invariant', () => {
  it('keeps the selected item within the visible window at the beginning of the transcript', () => {
    const windowSize = 15;
    const total = 40;

    for (let targetIdx = 0; targetIdx < 10; targetIdx++) {
      const startIdx = computeTranscriptWindowStartIdx(targetIdx, windowSize, total);
      expect(startIdx).toBe(0);
      expect(targetIdx).toBeGreaterThanOrEqual(startIdx);
      expect(targetIdx).toBeLessThan(startIdx + windowSize);
    }
  });

  it('scrolls the window smoothly as the user keys down past the padding boundary', () => {
    const windowSize = 15;
    const total = 40;
    const padding = 3;

    // At targetIdx = 12 (15 - 3), startIdx should increment to keep 3 items of context below
    const startIdx12 = computeTranscriptWindowStartIdx(12, windowSize, total, padding);
    expect(startIdx12).toBe(1);
    expect(12).toBeGreaterThanOrEqual(startIdx12);
    expect(12).toBeLessThan(startIdx12 + windowSize);

    // In the middle of the transcript (e.g. targetIdx = 20)
    const startIdx20 = computeTranscriptWindowStartIdx(20, windowSize, total, padding);
    expect(startIdx20).toBe(9);
    expect(20).toBeGreaterThanOrEqual(startIdx20);
    expect(20).toBeLessThan(startIdx20 + windowSize);
  });

  it('guarantees that the selected item NEVER scrolls past view across all 40 items', () => {
    const windowSize = 15;
    const total = 40;

    for (let targetIdx = 0; targetIdx < total; targetIdx++) {
      const startIdx = computeTranscriptWindowStartIdx(targetIdx, windowSize, total);
      // Mathematical invariant: selected item MUST be visible on screen
      expect(targetIdx).toBeGreaterThanOrEqual(startIdx);
      expect(targetIdx).toBeLessThan(startIdx + windowSize);
    }
  });

  it('clamps cleanly when navigating to the very last item in the transcript', () => {
    const windowSize = 15;
    const total = 40;
    const lastIdx = total - 1; // 39

    const startIdx = computeTranscriptWindowStartIdx(lastIdx, windowSize, total);
    expect(startIdx).toBe(25); // 40 - 15 = 25
    expect(lastIdx).toBeGreaterThanOrEqual(startIdx);
    expect(lastIdx).toBeLessThan(startIdx + windowSize);
  });

  it('handles small transcripts where total is less than window size', () => {
    const windowSize = 20;
    const total = 5;

    for (let targetIdx = 0; targetIdx < total; targetIdx++) {
      const startIdx = computeTranscriptWindowStartIdx(targetIdx, windowSize, total);
      expect(startIdx).toBe(0);
      expect(targetIdx).toBeGreaterThanOrEqual(startIdx);
      expect(targetIdx).toBeLessThan(startIdx + windowSize);
    }
  });

  it('handles empty transcripts without error', () => {
    expect(computeTranscriptWindowStartIdx(0, 15, 0)).toBe(0);
  });
});
