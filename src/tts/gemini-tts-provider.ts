import type { GoogleGenAI } from '@google/genai';
import type { VoiceName } from '../types/voice.js';
import { base64ToUint8Array } from './base64-to-uint8array.js';
import type { ITTSProvider } from './tts-provider.interface.js';
import { delay, calculateBackoffMs } from './backoff.js';

export class GeminiTTSProvider implements ITTSProvider {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly maxRetries = 3,
    private readonly model = 'gemini-3.1-flash-tts-preview'
  ) {}

  async *streamAudio(
    text: string,
    voice: VoiceName,
    promptStyle?: string
  ): AsyncIterable<Uint8Array> {
    let attempt = 0;

    while (true) {
      try {
        const trimmedStyle = promptStyle?.trim();
        const formattedInput = trimmedStyle
          ? `${trimmedStyle.startsWith('[') && trimmedStyle.endsWith(']') ? trimmedStyle : `[${trimmedStyle}]`}\n\n${text}`
          : text;

        const payload: any = {
          model: this.model,
          input: formattedInput,
          response_format: { type: 'audio' },
          generation_config: {
            speech_config: [{ voice }],
          },
          stream: true,
        };

        const stream = await this.client.interactions.create(payload);

        const chunkBuffer: Uint8Array[] = [];
        for await (const event of stream as unknown as AsyncIterable<any>) {
          if (event.event_type === 'error') {
            throw new Error(
              event.error?.message || 'Gemini TTS generation error from model'
            );
          }
          if (
            event.event_type === 'step.delta' &&
            event.delta?.type === 'audio' &&
            event.delta.data
          ) {
            chunkBuffer.push(base64ToUint8Array(event.delta.data));
          }
        }

        for (const pcm of chunkBuffer) {
          yield pcm;
        }
        return;
      } catch (err: any) {
        attempt++;
        const isRetryable =
          err?.status === 429 ||
          (err?.status >= 500 && err?.status < 600) ||
          err?.message?.includes('RETRYABLE') ||
          err?.name === 'RetryableApiError';

        if (!isRetryable || attempt > this.maxRetries) {
          throw err;
        }
        await delay(calculateBackoffMs(attempt - 1));
      }
    }
  }
}
