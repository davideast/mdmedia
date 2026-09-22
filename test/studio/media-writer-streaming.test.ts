import { describe, expect, it } from 'bun:test';
import {
  MediaStoreService,
  MemoryStorageAdapter,
  type MediaStore,
} from '../../studio/src/lib/media-store';
import type { NarrationTimingsFile } from '../../studio/src/lib/wav';

describe('Slice 3: Incremental MediaWriter Streaming & Finalization', () => {
  const sampleTimings: NarrationTimingsFile = {
    version: 1,
    title: 'Incremental Streaming Test',
    transcript: 'Chunk one. Chunk two. Chunk three.',
    voice: 'Zephyr',
    sampleRate: 24000,
    durationMs: 3000,
    chunks: [
      {
        index: 0,
        text: 'Chunk one.',
        startMs: 0,
        endMs: 1000,
        words: [{ word: 'Chunk', startMs: 0, endMs: 500, charStart: 0, charEnd: 5 }],
      },
      {
        index: 1,
        text: 'Chunk two.',
        startMs: 1000,
        endMs: 2000,
        words: [{ word: 'two.', startMs: 1000, endMs: 2000, charStart: 11, charEnd: 15 }],
      },
    ],
  };

  it('streams PCM chunks incrementally and patches WAV header upon finalization', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    const writer = await store.openWriter('stream-narr-1');

    // Simulate 3 incoming PCM chunks from Gemini TTS
    const chunk1 = new Uint8Array(24000 * 2); // 1 second of 16-bit mono = 48000 bytes
    chunk1.fill(1);
    const chunk2 = new Uint8Array(24000 * 2);
    chunk2.fill(2);
    const chunk3 = new Uint8Array(12000 * 2); // 0.5 seconds = 24000 bytes
    chunk3.fill(3);

    await writer.appendChunk(chunk1);
    await writer.appendChunk(chunk2);
    await writer.appendChunk(chunk3);

    const totalPcmBytes = chunk1.byteLength + chunk2.byteLength + chunk3.byteLength; // 120,000 bytes

    await writer.finalize(sampleTimings);

    // Verify track is ready and offline-accessible
    expect(await store.has('stream-narr-1')).toBe(true);

    const track = await store.getTrack('stream-narr-1');
    expect(track).not.toBeNull();
    if (!track) return;

    expect(track.timings).toEqual(sampleTimings);
    expect(track.audioBlob.size).toBe(44 + totalPcmBytes);

    // Verify WAV header contains accurate patched byte offsets
    const headerBuffer = await track.audioBlob.slice(0, 44).arrayBuffer();
    const view = new DataView(headerBuffer);

    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + totalPcmBytes); // RIFF chunk size
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');
    expect(view.getUint32(40, true)).toBe(totalPcmBytes); // SubChunk2 data size
  });

  it('aborts incomplete streaming generations and cleans up temporary files', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    const writer = await store.openWriter('aborted-narr-2');

    await writer.appendChunk(new Uint8Array([1, 2, 3, 4]));

    // Abort before finalize
    await writer.abort();

    expect(await store.has('aborted-narr-2')).toBe(false);
    expect(await store.getTrack('aborted-narr-2')).toBeNull();
  });
});
