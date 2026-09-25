import { describe, expect, it } from 'bun:test';
import { StreamingPcmPlayer } from '../../studio/src/lib/pcm-player.js';
import { createWavHeader } from '../../studio/src/lib/wav.js';

describe('Insight 89bc4dba: WAV header byte preservation pollutes SSE audio chunks', () => {
  it('strips 44-byte RIFF headers in StreamingPcmPlayer to prevent audio popping and sample offset drift', () => {
    const player = new StreamingPcmPlayer();
    const wavHeader = createWavHeader(4800); // 44 bytes

    player.append(wavHeader);

    // @ts-ignore
    const sampleCount = player.sampleCount;
    expect(sampleCount).toBe(0);
  });
});
