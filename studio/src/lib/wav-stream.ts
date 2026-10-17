/**
 * Plays a WAV recording while it downloads.
 *
 * A finished narration is 20 to 55 MB. Waiting for all of it before the first
 * sound meant tens of seconds of silence on a phone. This reads the response
 * as it arrives, hands PCM to the player straight away, and reports when
 * enough is buffered to start.
 */

/** The part of `StreamingPcmPlayer` this needs, so it can be tested alone. */
export interface PcmSink {
  append(pcm: Uint8Array): void;
  completeStream(): void;
  readonly durationMs: number;
}

const CHUNK_HEADER_BYTES = 8;

/** Where the `data` chunk's samples start, or null if more bytes are needed. Throws on a non-WAV. */
export function findPcmStart(prefix: Uint8Array): number | null {
  if (prefix.byteLength < 12) return null;
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('The narration audio is not a WAV recording.');
  let offset = 12;
  while (offset + CHUNK_HEADER_BYTES <= prefix.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === 'data') return offset + CHUNK_HEADER_BYTES;
    offset += CHUNK_HEADER_BYTES + size + (size % 2);
  }
  return null;
}

/**
 * Streams `body` into `sink`. `onBuffered` runs once, when `bufferMs` of audio
 * is ready or the recording ends sooner. Reading stops early, without
 * completing the sink, once `isCurrent` turns false.
 */
export async function streamWavInto(
  sink: PcmSink,
  body: ReadableStream<Uint8Array>,
  { bufferMs = 1000, onBuffered, isCurrent = () => true }: {
    bufferMs?: number;
    onBuffered?: () => void;
    isCurrent?: () => boolean;
  } = {},
): Promise<boolean> {
  const reader = body.getReader();
  let header: Uint8Array | null = new Uint8Array(0);
  let buffered = false;
  const reportBuffered = () => {
    if (buffered || sink.durationMs <= 0) return;
    buffered = true;
    onBuffered?.();
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!isCurrent()) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let pcm: Uint8Array = value;
      if (header !== null) {
        // Hold bytes until the header is complete, then pass the rest through.
        const joined: Uint8Array = new Uint8Array(header.byteLength + value.byteLength);
        joined.set(header, 0);
        joined.set(value, header.byteLength);
        const start = findPcmStart(joined);
        if (start === null) {
          header = joined;
          continue;
        }
        header = null;
        pcm = joined.subarray(start);
      }
      sink.append(pcm);
      if (sink.durationMs >= bufferMs) reportBuffered();
    }
  } finally {
    reader.releaseLock();
  }

  if (header !== null) throw new Error('The narration audio ended before its header.');
  reportBuffered();
  sink.completeStream();
  return true;
}
