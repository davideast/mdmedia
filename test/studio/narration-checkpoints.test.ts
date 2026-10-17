import { expect, test } from 'bun:test';

import {
  createCheckpointScheduler,
  shouldUploadCheckpoint,
  wrapPcmPartsAsWav,
} from '../../studio/src/lib/narration-checkpoints';
import { wrapPcmAsWav } from '../../studio/src/lib/wav';

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

test('a WAV built from PCM parts is byte-identical to wrapping the concatenated PCM', () => {
  const parts = [Uint8Array.of(1, 2, 3, 4), new Uint8Array(0), Uint8Array.of(5, 6), Uint8Array.of(7, 8, 9, 10)];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  expect(Array.from(wrapPcmPartsAsWav(parts, total))).toEqual(Array.from(wrapPcmAsWav(concat(parts))));
});

test('a checkpoint is uploaded first, then only after the audio has grown by half', () => {
  expect(shouldUploadCheckpoint(1_000, 0)).toBe(true);
  expect(shouldUploadCheckpoint(1_400, 1_000)).toBe(false);
  expect(shouldUploadCheckpoint(1_500, 1_000)).toBe(true);
});

test('uploads grow geometrically while every chunk still refreshes the document', async () => {
  const uploaded: number[] = [];
  let heartbeats = 0;
  let bytes = 0;
  const scheduler = createCheckpointScheduler({
    totalBytes: () => bytes,
    upload: async () => {
      uploaded.push(bytes);
      return bytes;
    },
    heartbeat: async () => {
      heartbeats += 1;
    },
  });

  const chunks = 200;
  for (let i = 0; i < chunks; i += 1) {
    bytes += 200_000;
    scheduler.request();
    await scheduler.settle();
  }

  expect(uploaded.length).toBeLessThan(20);
  expect(uploaded.length + heartbeats).toBe(chunks);
  // Rebuilding and re-uploading after every chunk would move ~chunks/2 times the
  // final size. Geometric checkpoints stay within a small multiple of it.
  expect(uploaded.reduce((sum, size) => sum + size, 0)).toBeLessThan(bytes * 4);
});

test('requests made while an upload is in flight collapse into one follow-up', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploads = 0;
  let heartbeats = 0;
  let bytes = 1_000;
  const scheduler = createCheckpointScheduler({
    totalBytes: () => bytes,
    upload: async () => {
      uploads += 1;
      if (uploads === 1) await gate;
      return bytes;
    },
    heartbeat: async () => {
      heartbeats += 1;
    },
  });

  scheduler.request();
  for (let i = 0; i < 5; i += 1) {
    bytes += 100;
    scheduler.request();
  }
  release();
  await scheduler.settle();

  expect(uploads + heartbeats).toBe(2);
});

test('a failed upload does not wedge later checkpoints', async () => {
  let calls = 0;
  let bytes = 0;
  const scheduler = createCheckpointScheduler({
    totalBytes: () => bytes,
    upload: async () => {
      calls += 1;
      if (calls === 1) throw new Error('storage unavailable');
      return bytes;
    },
    heartbeat: async () => {},
  });

  bytes = 1_000;
  scheduler.request();
  await scheduler.settle();
  bytes = 5_000;
  scheduler.request();
  await scheduler.settle();

  expect(calls).toBe(2);
});
