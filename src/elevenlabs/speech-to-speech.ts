import { calculateBackoffMs, delay } from '../tts/backoff.js';
import {
  ELEVENLABS_API_BASE_URL,
  ElevenLabsRequestError,
  isRetryableElevenLabsError,
  readElevenLabsErrorDetail,
} from './request-error.js';

/**
 * ElevenLabs speech-to-speech (the voice changer):
 * `POST /v1/speech-to-speech/{voice_id}` with the speech as a multipart file.
 * It keeps the speech's words, timing and acting and replaces the voice, which
 * is how an on-camera line from a video model is put into a character's fixed
 * voice (the voice swap; see docs/characters.md).
 */

/** The English speech-to-speech model; `eleven_multilingual_sts_v2` is the other. */
export const DEFAULT_STS_MODEL = 'eleven_english_sts_v2';

/** 44.1 kHz 16-bit PCM, little-endian, no header. */
export const DEFAULT_STS_OUTPUT = 'pcm_44100';

export interface SpeechToSpeechSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface SpeechToSpeechOptions {
  apiKey: string;
  /** The voice id (not its name; resolve names with `ElevenLabsVoiceCatalog`). */
  voiceId: string;
  model?: string;
  /** An `output_format` such as `pcm_44100` or `mp3_44100_192`. */
  outputFormat?: string;
  settings?: SpeechToSpeechSettings;
  /** ElevenLabs' audio isolation on the input first (drops crowd noise and room tone, and with them some breath). */
  removeBackgroundNoise?: boolean;
  seed?: number;
  /** The input's MIME type and name. Default `audio/wav`, `speech.wav`. */
  mimeType?: string;
  fileName?: string;
  maxRetries?: number;
  request?: typeof fetch;
}

/** The form a speech-to-speech request sends, apart from the audio. Exported for tests. */
export function speechToSpeechFields(options: Omit<SpeechToSpeechOptions, 'apiKey' | 'voiceId'>): Record<string, string> {
  const fields: Record<string, string> = { model_id: options.model ?? DEFAULT_STS_MODEL };
  if (options.settings && Object.keys(options.settings).length > 0) fields.voice_settings = JSON.stringify(options.settings);
  if (options.removeBackgroundNoise !== undefined) fields.remove_background_noise = String(options.removeBackgroundNoise);
  if (options.seed !== undefined) {
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 4294967295) throw new Error('seed must be a whole number from 0 to 4294967295.');
    fields.seed = String(options.seed);
  }
  return fields;
}

/**
 * Converts speech into another voice and returns the new audio's bytes, in
 * `outputFormat` (raw PCM for `pcm_*`). Rate limits, server errors and
 * network failures are retried.
 */
export async function speechToSpeech(audio: Uint8Array, options: SpeechToSpeechOptions): Promise<Uint8Array> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('An ElevenLabs API key is required for speech-to-speech. Set ELEVENLABS_API_KEY (or ELEVEN_LABS_KEY).');
  if (!options.voiceId.trim()) throw new Error('Speech-to-speech needs the voice id to convert to.');
  if (audio.byteLength === 0) throw new Error('Speech-to-speech needs some audio.');
  const request = options.request ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const fields = speechToSpeechFields(options);
  const url = new URL(`${ELEVENLABS_API_BASE_URL}/v1/speech-to-speech/${encodeURIComponent(options.voiceId)}`);
  url.searchParams.set('output_format', options.outputFormat ?? DEFAULT_STS_OUTPUT);

  for (let attempt = 0; ; attempt++) {
    try {
      const form = new FormData();
      const bytes = new Uint8Array(audio.byteLength);
      bytes.set(audio);
      form.append('audio', new Blob([bytes], { type: options.mimeType ?? 'audio/wav' }), options.fileName ?? 'speech.wav');
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      const response = await request(url, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
      if (!response.ok) throw new ElevenLabsRequestError(response.status, await readElevenLabsErrorDetail(response), 'speech-to-speech');
      const out = new Uint8Array(await response.arrayBuffer());
      if (out.byteLength === 0) throw new Error('ElevenLabs speech-to-speech returned no audio.');
      return out;
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableElevenLabsError(error)) throw error;
      await delay(calculateBackoffMs(attempt));
    }
  }
}

/** Raw 16-bit little-endian mono PCM wrapped as a WAV file. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** The sample rate of a `pcm_<rate>` output format, or null for any other. */
export function pcmRate(outputFormat: string): number | null {
  const match = /^pcm_(\d+)$/.exec(outputFormat);
  return match ? Number(match[1]) : null;
}
