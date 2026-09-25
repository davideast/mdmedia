import { describe, expect, it } from 'bun:test';
import { parseNarrationRequest } from '../../studio/src/lib/narration-request.js';

describe('Cross-Surface Feature & Parameter Parity (Insights 3a52ffa3, 10e4de4b, 3f1c0264, f25b0691)', () => {
  const baseRequest = {
    markdown: '# Introduction\n\nWelcome to mdmedia.',
    voice: 'Puck',
    promptStyle: 'Warm narration',
    visibility: 'private',
  };

  it('Studio request parser preserves speed and verbalizeDiagrams options', () => {
    const payload = {
      ...baseRequest,
      speed: 1.25,
      verbalizeDiagrams: true,
    };

    const parsed = parseNarrationRequest(payload);
    expect(parsed).not.toBeNull();
    expect((parsed as any).speed).toBe(1.25);
    expect((parsed as any).verbalizeDiagrams).toBe(true);
  });

  it('Studio request parser accepts custom voice identifiers', () => {
    const payload = {
      ...baseRequest,
      voice: 'custom-fine-tuned-voice',
    };
    const parsed = parseNarrationRequest(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.voice).toBe('custom-fine-tuned-voice');
  });

  it('Studio request parser preserves explicit false for verbalizeDiagrams', () => {
    const payload = {
      ...baseRequest,
      verbalizeDiagrams: false,
    };
    const parsed = parseNarrationRequest(payload);
    expect(parsed).not.toBeNull();
    expect((parsed as any).verbalizeDiagrams).toBe(false);
  });
});
