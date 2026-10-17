/**
 * Checkpointing for a narration that is still being synthesized.
 *
 * A checkpoint lets a reloaded page or another viewer pick up the audio made so
 * far. Uploading the whole growing recording after every chunk costs work
 * proportional to the square of the narration's length, so uploads are spaced
 * geometrically and the document is only touched in between.
 */

import { WAV_HEADER_BYTES } from "./types";
import { createWavHeader } from "./wav";

/** A new checkpoint is uploaded once the audio has grown by this factor. */
const CHECKPOINT_GROWTH = 1.5;

/**
 * Builds a playable WAV from PCM parts with one allocation, rather than
 * concatenating the parts and then copying the result again to add a header.
 */
export function wrapPcmPartsAsWav(parts: Uint8Array[], totalBytes: number): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + totalBytes);
  wav.set(createWavHeader(totalBytes), 0);
  let offset = WAV_HEADER_BYTES;
  for (const part of parts) {
    wav.set(part, offset);
    offset += part.byteLength;
  }
  return wav;
}

export function shouldUploadCheckpoint(totalBytes: number, uploadedBytes: number): boolean {
  return uploadedBytes === 0 || totalBytes >= uploadedBytes * CHECKPOINT_GROWTH;
}

interface CheckpointScheduler {
  /** Notes that another chunk finished. Never blocks the caller. */
  request: () => void;
  /** Resolves once no checkpoint work is running or waiting. */
  settle: () => Promise<void>;
}

export function createCheckpointScheduler(deps: {
  totalBytes: () => number;
  /** Uploads the recording so far and returns how many PCM bytes it held. */
  upload: () => Promise<number | undefined>;
  /** Refreshes the document so viewers do not mistake a live narration for a stalled one. */
  heartbeat: () => Promise<void>;
}): CheckpointScheduler {
  let uploadedBytes = 0;
  let running: Promise<void> | null = null;
  let requested = false;

  const drain = async (): Promise<void> => {
    // Requests that arrive while work is in flight collapse into one follow-up
    // that sees the latest totals, instead of queueing one upload per chunk.
    while (requested) {
      requested = false;
      try {
        if (shouldUploadCheckpoint(deps.totalBytes(), uploadedBytes)) {
          uploadedBytes = (await deps.upload()) ?? uploadedBytes;
        } else {
          await deps.heartbeat();
        }
      } catch {
        // A failed checkpoint is retried by the next chunk, and the final
        // recording is always persisted separately.
      }
    }
  };

  return {
    request() {
      requested = true;
      running ??= drain().finally(() => {
        running = null;
      });
    },
    async settle() {
      while (running) await running;
    },
  };
}
