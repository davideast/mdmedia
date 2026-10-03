import {
  ELEVENLABS_API_BASE_URL,
  ElevenLabsRequestError,
  isRetryableElevenLabsError,
  readElevenLabsErrorDetail,
} from '../elevenlabs/request-error.js';
import type { VoiceName } from '../types/voice.js';
import { calculateBackoffMs, delay } from './backoff.js';
import { ElevenLabsVoiceCatalog } from './elevenlabs-voices.js';
import type { ITTSProvider } from './tts-provider.interface.js';

export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2';

/** Streams headerless 24 kHz, 16-bit mono PCM for the existing narration pipeline. */
export class ElevenLabsTTSProvider implements ITTSProvider {
  private readonly voiceCatalog: ElevenLabsVoiceCatalog;
  private readonly voiceIds = new Map<string, Promise<string>>();

  static validateSelection(voice?: VoiceName, promptStyle?: string, requireVoice = false): void {
    if ((requireVoice || voice !== undefined) && !voice?.trim()) {
      throw new Error(
        'An ElevenLabs voice name or ID is required. Set --voice, ELEVENLABS_VOICE, or ELEVENLABS_VOICE_ID.'
      );
    }
    if (promptStyle?.trim()) {
      throw new Error('Free-form --style delivery notes are not supported by ElevenLabs TTS.');
    }
  }

  constructor(
    private readonly apiKey: string,
    private readonly maxRetries = 3,
    private readonly model = DEFAULT_ELEVENLABS_TTS_MODEL,
    private readonly request: typeof fetch = fetch
  ) {
    if (!apiKey.trim()) {
      throw new Error('ELEVENLABS_API_KEY environment variable is required.');
    }
    this.voiceCatalog = new ElevenLabsVoiceCatalog(apiKey, request);
  }

  private resolveVoiceId(voice: VoiceName): Promise<string> {
    const reference = voice.trim();
    const existing = this.voiceIds.get(reference);
    if (existing) return existing;
    const resolved = this.voiceCatalog.resolve(reference).catch((error) => {
      this.voiceIds.delete(reference);
      throw error;
    });
    this.voiceIds.set(reference, resolved);
    return resolved;
  }

  async *streamAudio(
    text: string,
    voice: VoiceName,
    promptStyle?: string
  ): AsyncIterable<Uint8Array> {
    ElevenLabsTTSProvider.validateSelection(voice, promptStyle, true);
    const voiceId = await this.resolveVoiceId(voice);

    const url = new URL(
      `${ELEVENLABS_API_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`
    );
    url.searchParams.set('output_format', 'pcm_24000');

    for (let attempt = 0; ; attempt++) {
      let emittedAudio = false;
      try {
        const response = await this.request(url, {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/pcm',
          },
          body: JSON.stringify({ text, model_id: this.model }),
        });

        if (!response.ok) {
          throw new ElevenLabsRequestError(response.status, await readElevenLabsErrorDetail(response));
        }
        if (!response.body) {
          throw new Error('ElevenLabs returned no audio stream.');
        }

        const reader = response.body.getReader();
        let finished = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              if (!emittedAudio) throw new Error('ElevenLabs returned no audio.');
              return;
            }
            if (value.byteLength > 0) {
              emittedAudio = true;
              yield value;
            }
          }
        } finally {
          if (!finished) await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        // Retrying after audio reached a caller would duplicate the spoken prefix.
        if (emittedAudio || attempt >= this.maxRetries || !isRetryableElevenLabsError(error)) throw error;
        await delay(calculateBackoffMs(attempt));
      }
    }
  }
}
