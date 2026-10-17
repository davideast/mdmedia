import { describe, expect, test } from 'bun:test';

import { findPcmStart, streamWavInto, type PcmSink } from '../../studio/src/lib/wav-stream';
import { wrapPcmAsWav } from '../../studio/src/lib/wav';

const BYTES_PER_MS = 48; // 24 kHz, 16-bit mono

function fakeSink() {
  const received: number[] = [];
  let completed = false;
  const sink: PcmSink & { received: number[]; completed: () => boolean } = {
    received,
    completed: () => completed,
    append(pcm) { received.push(...pcm); },
    completeStream() { completed = true; },
    get durationMs() { return Math.floor(received.length / 2) / 24; },
  };
  return sink;
}

/** A body that delivers `bytes` in pieces of `size`, recording how far it has been read. */
function body(bytes: Uint8Array, size: number) {
  let offset = 0;
  const reads = { count: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      reads.count += 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
  return { stream, reads };
}

const pcm = (ms: number) => Uint8Array.from({ length: ms * BYTES_PER_MS }, (_, i) => i % 251);

describe('findPcmStart', () => {
  test('finds the samples after the canonical header and after extra chunks', () => {
    expect(findPcmStart(wrapPcmAsWav(pcm(1)))).toBe(44);
    const wav = wrapPcmAsWav(pcm(1));
    const withList = new Uint8Array(wav.byteLength + 12);
    withList.set(wav.subarray(0, 36), 0);
    withList.set(new TextEncoder().encode('LIST'), 36);
    new DataView(withList.buffer).setUint32(40, 4, true);
    withList.set(wav.subarray(36), 48);
    expect(findPcmStart(withList)).toBe(56);
  });

  test('asks for more bytes until the data chunk is visible, and refuses non-WAV', () => {
    expect(findPcmStart(wrapPcmAsWav(pcm(1)).subarray(0, 30))).toBeNull();
    expect(() => findPcmStart(new TextEncoder().encode('<html>not audio</html>'))).toThrow();
  });
});

describe('streamWavInto', () => {
  test('passes every sample through, whatever size the network pieces are', async () => {
    const samples = pcm(250);
    for (const size of [7, 44, 45, 1000, 1_000_000]) {
      const sink = fakeSink();
      expect(await streamWavInto(sink, body(wrapPcmAsWav(samples), size).stream)).toBe(true);
      expect(sink.received).toEqual(Array.from(samples));
      expect(sink.completed()).toBe(true);
    }
  });

  test('reports buffered once, long before the download ends', async () => {
    const sink = fakeSink();
    const { stream, reads } = body(wrapPcmAsWav(pcm(10_000)), 4_800); // 100 ms per piece
    let readsWhenBuffered = -1;
    let calls = 0;
    await streamWavInto(sink, stream, { bufferMs: 1000, onBuffered: () => { calls += 1; readsWhenBuffered = reads.count; } });
    expect(calls).toBe(1);
    expect(readsWhenBuffered).toBeLessThanOrEqual(12);
    expect(reads.count).toBeGreaterThan(90);
  });

  test('a recording shorter than the buffer still reports buffered at the end', async () => {
    let calls = 0;
    await streamWavInto(fakeSink(), body(wrapPcmAsWav(pcm(200)), 1000).stream, { bufferMs: 1000, onBuffered: () => { calls += 1; } });
    expect(calls).toBe(1);
  });

  test('stops reading, without completing, once the load is no longer current', async () => {
    const sink = fakeSink();
    const { stream, reads } = body(wrapPcmAsWav(pcm(10_000)), 4_800);
    let current = true;
    const finished = await streamWavInto(sink, stream, { isCurrent: () => current, onBuffered: () => { current = false; } });
    expect(finished).toBe(false);
    expect(sink.completed()).toBe(false);
    expect(reads.count).toBeLessThan(20);
  });

  test('a body that is not a WAV fails instead of playing noise', async () => {
    const html = new TextEncoder().encode('<!doctype html><title>Sign in</title>');
    await expect(streamWavInto(fakeSink(), body(html, 100).stream)).rejects.toThrow();
  });
});
