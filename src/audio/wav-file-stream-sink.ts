import fs from 'node:fs';
import { mkdir, open as openFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { UniversalEventBus } from '../pipeline/pipeline-event-bus.js';
import { createWavHeader } from './wav-header.js';

export class WavFileStreamSink {
  private readonly destination: string;
  private writeStream?: fs.WriteStream;
  private bytesWritten = 0;
  private unsubscribeDelta?: () => void;
  private unsubscribeComplete?: () => void;
  private unsubscribeError?: () => void;
  private openPromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private finalizePromise?: Promise<void>;

  constructor(destination: string) {
    this.destination = resolve(destination);
  }

  async open(): Promise<void> {
    if (this.writeStream) return;
    if (this.openPromise) return this.openPromise;

    const parentDir = dirname(this.destination);
    await mkdir(parentDir, { recursive: true });

    this.openPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = fs.createWriteStream(this.destination);
      this.writeStream = stream;

      stream.once('error', rejectPromise);
      const placeholder = new Uint8Array(44);
      stream.write(placeholder, (err) => {
        if (err) {
          rejectPromise(err);
        } else {
          resolvePromise();
        }
      });
    });

    await this.openPromise;
  }

  attachToEventBus(
    eventBus: UniversalEventBus,
    sampleRate = 24000,
    channels = 1,
    bitDepth = 16
  ): void {
    this.unsubscribeDelta = eventBus.on('audio:delta', ({ audioData }) => {
      this.writePCMChunk(audioData).catch((err) => {
        console.error('[WavFileStreamSink] Error writing PCM delta:', err);
      });
    });

    // These listeners RETURN their promises so `emitAndWait` can await them.
    // Returning rather than floating is what guarantees the file is complete
    // by the time processDocument() resolves.
    this.unsubscribeComplete = eventBus.on('pipeline:complete', () =>
      this.finalize(sampleRate, channels, bitDepth)
    );

    this.unsubscribeError = eventBus.on('pipeline:error', async () => {
      await this.writeQueue.catch(() => {});
      return this.finalize(sampleRate, channels, bitDepth);
    });
  }

  detach(): void {
    if (this.unsubscribeDelta) {
      this.unsubscribeDelta();
      this.unsubscribeDelta = undefined;
    }
    if (this.unsubscribeComplete) {
      this.unsubscribeComplete();
      this.unsubscribeComplete = undefined;
    }
    if (this.unsubscribeError) {
      this.unsubscribeError();
      this.unsubscribeError = undefined;
    }
  }

  writePCMChunk(chunk: Uint8Array): Promise<void> {
    if (this.finalizePromise) {
      // open() would early-return on the stale openPromise, leaving writeStream
      // undefined and throwing an opaque TypeError below. Fail clearly instead.
      return Promise.reject(
        new Error(
          `WavFileStreamSink: cannot write after finalize() (${this.destination}). ` +
            `Create a new sink for a new file.`
        )
      );
    }
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.writeStream) {
        await this.open();
      } else if (this.openPromise) {
        await this.openPromise;
      }
      this.bytesWritten += chunk.byteLength;
      return new Promise<void>((resolvePromise, rejectPromise) => {
        this.writeStream!.write(chunk, (err) => (err ? rejectPromise(err) : resolvePromise()));
      });
    });
    return this.writeQueue;
  }

  private closeStream(): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (!this.writeStream) {
        resolvePromise();
        return;
      }
      const stream = this.writeStream;
      if (stream.closed) {
        this.writeStream = undefined;
        resolvePromise();
        return;
      }
      stream.once('error', rejectPromise);
      stream.once('close', () => {
        this.writeStream = undefined;
        resolvePromise();
      });
      stream.end();
    });
  }

  /**
   * Drains pending writes, closes the stream, and rewrites the 44-byte header
   * with the real sizes.
   *
   * Idempotent: repeated calls return the same promise and perform no extra I/O,
   * so calling it explicitly after `processDocument()` (which now awaits it via
   * `pipeline:complete`) is safe and cheap.
   */
  finalize(sampleRate = 24000, channels = 1, bitDepth = 16): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;

    this.finalizePromise = (async () => {
      // Wait for all pending delta writes in the queue to finish writing to disk
      await this.writeQueue;
      await this.closeStream();

      const header = createWavHeader(this.bytesWritten, sampleRate, channels, bitDepth);
      const fd = await openFile(this.destination, 'r+');
      try {
        await fd.write(header, 0, header.length, 0);
      } finally {
        await fd.close();
      }
    })();

    return this.finalizePromise;
  }

  /** True once `finalize()` has been invoked (whether or not it has settled). */
  isFinalized(): boolean {
    return this.finalizePromise !== undefined;
  }

  getBytesWritten(): number {
    return this.bytesWritten;
  }

  getDestination(): string {
    return this.destination;
  }
}
