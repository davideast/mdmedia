import { PCM_RATE } from './ports.js';

/** Milliseconds of 24 kHz 16-bit mono PCM. */
export function pcmDurationMs(pcm: Uint8Array): number {
  return Math.round((pcm.byteLength / 2 / PCM_RATE) * 1000);
}

/** A complete WAV file around 16-bit PCM. */
export function wavFromPcm(pcm: Uint8Array, rate = PCM_RATE, channels = 1): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => [...value].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, channels, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * channels * 2, true);
  header.setUint16(32, channels * 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(pcm, 44);
  return out;
}

/** The PCM inside a WAV file written by `wavFromPcm`. */
export function pcmFromWav(wav: Uint8Array): Uint8Array {
  return wav.subarray(44);
}

/** Silence of a given length. */
export function silence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((ms * PCM_RATE) / 1000) * 2);
}

/** Places clips at their start times on one track; overlaps are summed and clipped. */
export function mixClips(clips: Array<{ pcm: Uint8Array; startMs: number }>, durationMs: number): Uint8Array {
  const total = Math.round((durationMs * PCM_RATE) / 1000);
  const out = new Int16Array(total);
  for (const clip of clips) {
    const samples = new Int16Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength >> 1);
    const start = Math.round((clip.startMs * PCM_RATE) / 1000);
    for (let i = 0; i < samples.length && start + i < total; i++) {
      out[start + i] = Math.max(-32768, Math.min(32767, out[start + i]! + samples[i]!));
    }
  }
  return new Uint8Array(out.buffer);
}
