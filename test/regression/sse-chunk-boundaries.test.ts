import { describe, expect, it } from 'bun:test';
import { alignAudioDelta } from '../../studio/src/lib/narration-server.js';

describe('Insight c9861711: SSE chunk boundaries desynchronize word timing offsets', () => {
  it('enforces 2-byte 16-bit PCM sample alignment across sequential deltas', () => {
    const chunk1 = new Uint8Array(1001);
    const chunk2 = new Uint8Array(1001);

    const step1 = alignAudioDelta(chunk1, null);
    expect(step1.aligned.byteLength % 2).toBe(0);
    expect(step1.aligned.byteLength).toBe(1000);
    expect(step1.carry?.byteLength).toBe(1);

    const step2 = alignAudioDelta(chunk2, step1.carry);
    expect(step2.aligned.byteLength % 2).toBe(0);
    expect(step2.aligned.byteLength).toBe(1002);
    expect(step2.carry).toBeNull();
  });
});
