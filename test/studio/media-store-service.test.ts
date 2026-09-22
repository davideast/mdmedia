import { describe, expect, it } from 'bun:test';
import {
  MediaStoreService,
  MemoryStorageAdapter,
  type MediaStore,
} from '../../studio/src/lib/media-store';
import type { NarrationTimingsFile } from '../../studio/src/lib/wav';

describe('Slice 2: MediaStore Core Service', () => {
  const sampleTimings: NarrationTimingsFile = {
    version: 1,
    title: 'Offline Architecture Narration',
    transcript: 'Audio is now available offline.',
    voice: 'Puck',
    sampleRate: 24000,
    durationMs: 2500,
    chunks: [
      {
        index: 0,
        text: 'Audio is now available offline.',
        startMs: 0,
        endMs: 2500,
        words: [
          { word: 'Audio', startMs: 0, endMs: 500, charStart: 0, charEnd: 5 },
          { word: 'is', startMs: 510, endMs: 700, charStart: 6, charEnd: 8 },
          { word: 'now', startMs: 710, endMs: 1000, charStart: 9, charEnd: 12 },
          { word: 'available', startMs: 1010, endMs: 1800, charStart: 13, charEnd: 22 },
          { word: 'offline.', startMs: 1810, endMs: 2500, charStart: 23, charEnd: 31 },
        ],
      },
    ],
  };

  const sampleAudioBytes = new Uint8Array([82, 73, 70, 70, 44, 0, 0, 0, 87, 65, 86, 69]); // dummy RIFF header
  const sampleBlob = new Blob([sampleAudioBytes], { type: 'audio/wav' });

  it('saves track, reports existence via has(), and retrieves audio blob + timings', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    expect(await store.has('narr-1')).toBe(false);

    await store.saveTrack('narr-1', sampleBlob, sampleTimings);

    expect(await store.has('narr-1')).toBe(true);

    const track = await store.getTrack('narr-1');
    expect(track).not.toBeNull();
    if (!track) return;

    expect(track.timings).toEqual(sampleTimings);
    const audioArray = new Uint8Array(await track.audioBlob.arrayBuffer());
    expect(audioArray).toEqual(sampleAudioBytes);
    expect(track.audioBlob.type).toBe('audio/wav');
  });

  it('retrieves timings independently via getTimings()', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    await store.saveTrack('narr-2', sampleBlob, sampleTimings);

    const timings = await store.getTimings('narr-2');
    expect(timings).toEqual(sampleTimings);

    expect(await store.getTimings('non-existent')).toBeNull();
  });

  it('deletes audio and timings files when delete() is called', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    await store.saveTrack('narr-3', sampleBlob, sampleTimings);
    expect(await store.has('narr-3')).toBe(true);

    await store.delete('narr-3');
    expect(await store.has('narr-3')).toBe(false);
    expect(await store.getTrack('narr-3')).toBeNull();
    expect(await store.getTimings('narr-3')).toBeNull();
  });

  it('reports storage usage metrics accurately', async () => {
    const adapter = new MemoryStorageAdapter();
    const store: MediaStore = new MediaStoreService(adapter);

    const initialUsage = await store.getStorageUsage();
    expect(initialUsage.usedBytes).toBe(0);

    await store.saveTrack('narr-4', sampleBlob, sampleTimings);

    const updatedUsage = await store.getStorageUsage();
    expect(updatedUsage.usedBytes).toBeGreaterThan(sampleAudioBytes.byteLength);
  });
});
