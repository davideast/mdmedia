import type { VoiceName } from '../types/voice.js';

export interface ITTSProvider {
  /** Yield headerless 24 kHz, signed 16-bit, mono PCM. Callers use the bytes for WAV and playback. */
  streamAudio(
    text: string,
    voice: VoiceName,
    promptStyle?: string
  ): AsyncIterable<Uint8Array>;
}
