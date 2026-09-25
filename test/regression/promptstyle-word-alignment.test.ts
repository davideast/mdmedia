import { describe, expect, it } from 'bun:test';
import { extractWordTimingsFromPcm } from '../../src/audio/player/word-aligner.js';

describe('Insight 08605905: PromptStyle bracket syntax corrupts word alignment offsets', () => {
  const pcmBuffer = new Uint8Array(4800); // 100ms at 24kHz 16-bit mono

  it('strips bracketed prompt directives so only spoken words are aligned with correct indices and offsets', () => {
    const text = '[style: whisper] Hello world';
    const timings = extractWordTimingsFromPcm(pcmBuffer, text);

    expect(timings.map((t) => t.word)).toEqual(['Hello', 'world']);
    expect(timings[0].wordIndex).toBe(0);
    expect(timings[1].wordIndex).toBe(1);
    expect(timings[0].charStart).toBe(17);
    expect(timings[0].charEnd).toBe(22);
    expect(timings[1].charStart).toBe(23);
    expect(timings[1].charEnd).toBe(28);
  });
});
