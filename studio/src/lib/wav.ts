/**
 * WAV container helpers.
 *
 * Isomorphic and dependency free: the generation route uses this to build the
 * file it uploads to Storage, and the browser player uses it to understand a
 * file it downloads back. Everything here assumes the one format the product
 * speaks — 24 kHz, 16-bit, mono.
 */

import { SAMPLE_RATE, WAV_HEADER_BYTES, type AlignedChunk } from "./types";

const DEFAULT_CHANNELS = 1;
const DEFAULT_BIT_DEPTH = 16;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Builds the canonical 44-byte RIFF/WAVE header for a PCM payload of
 * `pcmByteLength` bytes.
 */
export function createWavHeader(
  pcmByteLength: number,
  sampleRate: number = SAMPLE_RATE,
  channels: number = DEFAULT_CHANNELS,
  bitDepth: number = DEFAULT_BIT_DEPTH,
): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmByteLength, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, pcmByteLength, true);

  return header;
}

/** Prefixes raw PCM with a matching header, producing a playable WAV file. */
export function wrapPcmAsWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  wav.set(createWavHeader(pcm.byteLength), 0);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

/**
 * The timings sidecar uploaded next to the audio, at
 * `narrations/{uid}/{id}.timings.json`.
 *
 * It carries everything the reader needs to replay a finished narration, so a
 * replay costs exactly two signed-URL reads and no extra document fetches.
 */
export interface NarrationTimingsFile {
  id: string;
  title: string;
  transcript: string;
  durationMs: number;
  chunks: AlignedChunk[];
}
