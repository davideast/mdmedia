import { describe, expect, it } from 'bun:test';
import {
  MediaStoreService,
  MemoryStorageAdapter,
  getMediaStore,
} from '../../studio/src/lib/media-store';
import type { NarrationTimingsFile } from '../../studio/src/lib/wav';

describe('Slice 4: Offline Audio Integration & Storage Lifecycle', () => {
  const sampleTimings: NarrationTimingsFile = {
    version: 1,
    title: 'Offline Reader Integration',
    transcript: 'Testing seamless offline playback.',
    voice: 'Kore',
    sampleRate: 24000,
    durationMs: 1800,
    chunks: [
      {
        index: 0,
        text: 'Testing seamless offline playback.',
        startMs: 0,
        endMs: 1800,
        words: [
          { word: 'Testing', startMs: 0, endMs: 400, charStart: 0, charEnd: 7 },
          { word: 'seamless', startMs: 410, endMs: 800, charStart: 8, charEnd: 16 },
          { word: 'offline', startMs: 810, endMs: 1200, charStart: 17, charEnd: 24 },
          { word: 'playback.', startMs: 1210, endMs: 1800, charStart: 25, charEnd: 34 },
        ],
      },
    ],
  };

  const sampleAudioBlob = new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])], {
    type: 'audio/wav',
  });

  it('resolves audio track offline-first without requiring network requests', async () => {
    const adapter = new MemoryStorageAdapter();
    const mediaStore = new MediaStoreService(adapter);

    // Pre-populate offline store
    await mediaStore.saveTrack('offline-narr-100', sampleAudioBlob, sampleTimings);

    // Caller checks offline availability
    const isOfflineAvailable = await mediaStore.has('offline-narr-100');
    expect(isOfflineAvailable).toBe(true);

    const offlineTrack = await mediaStore.getTrack('offline-narr-100');
    expect(offlineTrack).not.toBeNull();
    expect(offlineTrack?.timings.title).toBe('Offline Reader Integration');
    expect(offlineTrack?.audioBlob.type).toBe('audio/wav');
  });

  it('caches freshly downloaded network tracks for future offline availability', async () => {
    const adapter = new MemoryStorageAdapter();
    const mediaStore = new MediaStoreService(adapter);

    expect(await mediaStore.has('network-narr-200')).toBe(false);

    // Simulate network pull completing and caching track
    await mediaStore.saveTrack('network-narr-200', sampleAudioBlob, sampleTimings);

    expect(await mediaStore.has('network-narr-200')).toBe(true);
    const cached = await mediaStore.getTrack('network-narr-200');
    expect(cached?.timings.transcript).toBe('Testing seamless offline playback.');
  });

  it('deletes offline audio and timings when narration is deleted', async () => {
    const adapter = new MemoryStorageAdapter();
    const mediaStore = new MediaStoreService(adapter);

    await mediaStore.saveTrack('deleted-narr-300', sampleAudioBlob, sampleTimings);
    expect(await mediaStore.has('deleted-narr-300')).toBe(true);

    // Simulate narration deletion cascade
    await mediaStore.delete('deleted-narr-300');

    expect(await mediaStore.has('deleted-narr-300')).toBe(false);
    expect(await mediaStore.getTrack('deleted-narr-300')).toBeNull();
  });
});
