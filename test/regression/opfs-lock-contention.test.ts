import { describe, expect, it } from 'bun:test';
import { MediaStoreService } from '../../studio/src/lib/media-store.js';

describe('Insight ef7bb410: Unhandled lock failure in OPFS audio store', () => {
  const lockingAdapter = {
    writeFile: async () => {
      const err = new Error('The requested file could not be accessed, being locked by another transaction');
      err.name = 'NoModificationAllowedError';
      throw err;
    },
    appendFile: async () => {},
    patchFile: async () => {},
    readFile: async () => null,
    readSlice: async () => null,
    hasFile: async () => false,
    deleteFile: async () => {},
    getUsage: async () => ({ usedBytes: 0, quotaBytes: 100 }),
  };

  it('falls back to memory storage when OPFS lock contention occurs', async () => {
    const store = new MediaStoreService(lockingAdapter as any);

    let failed = false;
    try {
      await store.saveTrack(
        'test-narration',
        new Blob([new Uint8Array(100)]),
        { id: 'test', title: 't', transcript: 'tr', durationMs: 100, chunks: [] }
      );
    } catch {
      failed = true;
    }

    expect(failed).toBe(false);
  });
});
