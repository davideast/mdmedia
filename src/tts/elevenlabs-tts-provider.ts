import type { VoiceName } from '../types/voice.js';
import { calculateBackoffMs, delay } from './backoff.js';
import type { ITTSProvider } from './tts-provider.interface.js';

export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2';

class ElevenLabsRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`ElevenLabs TTS request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ElevenLabsRequestError';
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof ElevenLabsRequestError
    ? error.status === 429 || error.status >= 500
    : error instanceof TypeError;
}

/** Streams headerless 24 kHz, 16-bit mono PCM for the existing narration pipeline. */
export class ElevenLabsTTSProvider implements ITTSProvider {
  static validateSelection(voice?: VoiceName, promptStyle?: string, requireVoice = false): void {
    if ((requireVoice || voice !== undefined) && !voice?.trim()) {
      throw new Error('An ElevenLabs voice ID is required. Set --voice or ELEVENLABS_VOICE_ID.');
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
  }

  async *streamAudio(
    text: string,
    voice: VoiceName,
    promptStyle?: string
  ): AsyncIterable<Uint8Array> {
    ElevenLabsTTSProvider.validateSelection(voice, promptStyle, true);

    const url = new URL(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`
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
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          throw new ElevenLabsRequestError(response.status, detail);
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
        if (emittedAudio || attempt >= this.maxRetries || !isRetryable(error)) throw error;
        await delay(calculateBackoffMs(attempt));
      }
    }
  }
}
