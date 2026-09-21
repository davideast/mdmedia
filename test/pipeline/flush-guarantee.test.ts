import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentAudioPipeline } from '../../src/pipeline/document-audio-pipeline.js';
import { UniversalEventBus } from '../../src/pipeline/pipeline-event-bus.js';
import { WavFileStreamSink } from '../../src/audio/wav-file-stream-sink.js';
import type { ITTSProvider } from '../../src/tts/tts-provider.interface.js';
import type { DocumentChunk } from '../../src/types/chunk.js';

const SCRATCH = resolve(tmpdir(), 'mdmedia-flush-test');

/** Emits PCM in many small deltas so the sink's write queue is deep at completion. */
class BurstTTSProvider implements ITTSProvider {
  constructor(private readonly deltasPerChunk = 40, private readonly deltaBytes = 1200) {}
  async *streamAudio(): AsyncIterable<Uint8Array> {
    for (let i = 0; i < this.deltasPerChunk; i++) {
      yield new Uint8Array(this.deltaBytes).fill(i % 256);
    }
  }
}

function makeChunks(n: number): DocumentChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `chunk-${i}`,
    index: i,
    text: `Sentence number ${i}.`,
    charCount: 20,
    wordCount: 3,
  }));
}

describe('Pipeline flush guarantees (regression: WAV truncated on processDocument resolve)', () => {
  afterEach(async () => {
    await rm(SCRATCH, { recursive: true, force: true });
  });

  it('writes the COMPLETE wav before processDocument() resolves — no explicit finalize()', async () => {
    const dest = resolve(SCRATCH, 'complete.wav');
    const chunks = makeChunks(6);
    const deltasPerChunk = 40;
    const deltaBytes = 1200;
    const expectedPcm = chunks.length * deltasPerChunk * deltaBytes;

    const bus = new UniversalEventBus();
    const sink = new WavFileStreamSink(dest);
    sink.attachToEventBus(bus, 24000, 1, 16);
    await sink.open();

    await new DocumentAudioPipeline(new BurstTTSProvider(deltasPerChunk, deltaBytes), bus)
      .processDocument(chunks, 'Puck');

    // Deliberately NO `await sink.finalize()` here. Before the fix this observed
    // ~2.7% of the audio and a header still reading dataSize 0.
    const bytes = await readFile(dest);
    expect(sink.getBytesWritten()).toBe(expectedPcm);
    expect(bytes.byteLength).toBe(44 + expectedPcm);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(40, true)).toBe(expectedPcm); // data chunk size rewritten
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(36 + expectedPcm); // RIFF chunk size
  });

  it('finalize() is idempotent and does not corrupt an already-finalized file', async () => {
    const dest = resolve(SCRATCH, 'idempotent.wav');
    const chunks = makeChunks(2);
    const bus = new UniversalEventBus();
    const sink = new WavFileStreamSink(dest);
    sink.attachToEventBus(bus, 24000, 1, 16);
    await sink.open();

    await new DocumentAudioPipeline(new BurstTTSProvider(5, 480), bus).processDocument(chunks, 'Puck');

    const afterPipeline = await readFile(dest);
    expect(sink.isFinalized()).toBe(true);

    // The previously-documented workaround: calling it again must be a no-op.
    await sink.finalize();
    await sink.finalize(24000, 1, 16);

    const afterExtraFinalize = await readFile(dest);
    expect(afterExtraFinalize.byteLength).toBe(afterPipeline.byteLength);
    expect(Buffer.compare(afterExtraFinalize, afterPipeline)).toBe(0);
  });

  it('rejects writes after finalize instead of throwing an opaque stream error', async () => {
    const dest = resolve(SCRATCH, 'after-finalize.wav');
    const sink = new WavFileStreamSink(dest);
    await sink.open();
    await sink.writePCMChunk(new Uint8Array(96));
    await sink.finalize();

    await expect(sink.writePCMChunk(new Uint8Array(48))).rejects.toThrow(/cannot write after finalize/i);

    // The finished file is untouched by the rejected write.
    const bytes = await readFile(dest);
    expect(bytes.byteLength).toBe(44 + 96);
  });

  it('closes the stream before the error surfaces when synthesis fails', async () => {
    const dest = resolve(SCRATCH, 'errored.wav');
    const bus = new UniversalEventBus();
    const sink = new WavFileStreamSink(dest);
    sink.attachToEventBus(bus, 24000, 1, 16);
    await sink.open();

    const failing: ITTSProvider = {
      // eslint-disable-next-line require-yield
      async *streamAudio(): AsyncIterable<Uint8Array> {
        throw new Error('TTS exploded');
      },
    };

    await expect(
      new DocumentAudioPipeline(failing, bus).processDocument(makeChunks(1), 'Puck')
    ).rejects.toThrow('TTS exploded');

    expect(fs.existsSync(dest)).toBe(true);
  });
});

describe('UniversalEventBus.emitAndWait', () => {
  it('awaits async listeners, unlike emit', async () => {
    const bus = new UniversalEventBus();
    let done = false;
    bus.on('pipeline:complete', async () => {
      await new Promise((r) => setTimeout(r, 25));
      done = true;
    });

    bus.emit('pipeline:complete', { totalChunksProcessed: 0, totalBytesGenerated: 0 });
    expect(done).toBe(false); // fire-and-forget

    await bus.emitAndWait('pipeline:complete', { totalChunksProcessed: 0, totalBytesGenerated: 0 });
    expect(done).toBe(true);
  });

  it('runs listeners concurrently and still propagates a rejection', async () => {
    const bus = new UniversalEventBus();
    const order: string[] = [];

    bus.on('pipeline:complete', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('slow');
    });
    bus.on('pipeline:complete', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('fast');
      throw new Error('sink failed');
    });

    await expect(
      bus.emitAndWait('pipeline:complete', { totalChunksProcessed: 0, totalBytesGenerated: 0 })
    ).rejects.toThrow('sink failed');

    // Concurrent, not serial: the fast listener finished first, and the slow one
    // still ran to completion despite the other rejecting.
    expect(order).toEqual(['fast', 'slow']);
  });

  it('tolerates a listener unsubscribing during dispatch', async () => {
    const bus = new UniversalEventBus();
    const seen: string[] = [];
    const off = bus.on('pipeline:complete', () => {
      seen.push('a');
      off();
    });
    bus.on('pipeline:complete', () => {
      seen.push('b');
    });

    await bus.emitAndWait('pipeline:complete', { totalChunksProcessed: 0, totalBytesGenerated: 0 });
    expect(seen).toEqual(['a', 'b']);
  });
});
