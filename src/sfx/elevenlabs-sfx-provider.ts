import { createWavHeader } from '../audio/wav-header.js';
import {
  ELEVENLABS_API_BASE_URL,
  ElevenLabsRequestError,
  isRetryableElevenLabsError,
  readElevenLabsErrorDetail,
} from '../elevenlabs/request-error.js';
import { calculateBackoffMs, delay } from '../tts/backoff.js';
import type {
  GenerateSoundEffectOptions,
  ISoundEffectsProvider,
  SoundEffectResult,
} from './sfx-provider.interface.js';

export const DEFAULT_ELEVENLABS_SFX_MODEL = 'eleven_text_to_sound_v2';

const MP3_OUTPUT_FORMAT = 'mp3_44100_128';
const PCM_SAMPLE_RATE = 44100;

/** Generates sound effects as MP3, or as 44.1 kHz 16-bit mono PCM wrapped in a WAV header. */
export class ElevenLabsSoundEffectsProvider implements ISoundEffectsProvider {
  static validateOptions(options: GenerateSoundEffectOptions = {}): void {
    const { durationSeconds, promptInfluence } = options;
    if (
      durationSeconds !== undefined &&
      !(Number.isFinite(durationSeconds) && durationSeconds >= 0.5 && durationSeconds <= 30)
    ) {
      throw new Error('Sound effect duration must be between 0.5 and 30 seconds.');
    }
    if (
      promptInfluence !== undefined &&
      !(Number.isFinite(promptInfluence) && promptInfluence >= 0 && promptInfluence <= 1)
    ) {
      throw new Error('Sound effect prompt influence must be between 0 and 1.');
    }
  }

  constructor(
    private readonly apiKey: string,
    private readonly maxRetries = 3,
    private readonly model = DEFAULT_ELEVENLABS_SFX_MODEL,
    private readonly request: typeof fetch = fetch
  ) {
    if (!apiKey.trim()) {
      throw new Error('ELEVENLABS_API_KEY environment variable is required.');
    }
  }

  async generate(
    prompt: string,
    options: GenerateSoundEffectOptions = {}
  ): Promise<SoundEffectResult> {
    if (!prompt.trim()) {
      throw new Error('A sound effect prompt is required.');
    }
    ElevenLabsSoundEffectsProvider.validateOptions(options);

    const outputFormat = options.outputFormat ?? 'mp3';
    const url = new URL(`${ELEVENLABS_API_BASE_URL}/v1/sound-generation`);
    url.searchParams.set(
      'output_format',
      outputFormat === 'wav' ? `pcm_${PCM_SAMPLE_RATE}` : MP3_OUTPUT_FORMAT
    );

    const body: Record<string, unknown> = {
      text: prompt,
      model_id: options.model ?? this.model,
    };
    if (options.durationSeconds !== undefined) body.duration_seconds = options.durationSeconds;
    if (options.promptInfluence !== undefined) body.prompt_influence = options.promptInfluence;
    if (options.loop !== undefined) body.loop = options.loop;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(url, {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new ElevenLabsRequestError(
            response.status,
            await readElevenLabsErrorDetail(response),
            'sound effects'
          );
        }

        const audio = new Uint8Array(await response.arrayBuffer());
        if (audio.byteLength === 0) {
          throw new Error('ElevenLabs returned no sound effect audio.');
        }

        if (outputFormat === 'wav') {
          const wav = new Uint8Array(44 + audio.byteLength);
          wav.set(createWavHeader(audio.byteLength, PCM_SAMPLE_RATE), 0);
          wav.set(audio, 44);
          return { audioBytes: wav, mimeType: 'audio/wav', outputFormat };
        }
        return { audioBytes: audio, mimeType: 'audio/mpeg', outputFormat };
      } catch (error) {
        // The response is buffered whole, so a retry never duplicates audio for the caller.
        if (attempt >= this.maxRetries || !isRetryableElevenLabsError(error)) throw error;
        await delay(calculateBackoffMs(attempt));
      }
    }
  }
}
