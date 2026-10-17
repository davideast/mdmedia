import type { GoogleGenAI } from '@google/genai';
import type { VoiceName } from '../types/voice.js';
import { base64ToUint8Array } from './base64-to-uint8array.js';
import type { ITTSProvider } from './tts-provider.interface.js';
import { delay, calculateBackoffMs } from './backoff.js';

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_MESSAGE_KEYWORDS = [
  'retryable',
  'econnreset',
  'etimedout',
  'fetch failed',
  'terminated',
  'socket hang up',
  'eai_again',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
];

export function isRetryableGeminiTtsError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof TypeError) return true;

  let current: any = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const status = Number(
      current?.status ?? current?.statusCode ?? current?.error?.status ?? 0
    );
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    if (current?.name === 'RetryableApiError' || current instanceof TypeError) {
      return true;
    }
    const code = String(current?.code ?? current?.error?.code ?? '').toUpperCase();
    if (code && TRANSIENT_ERROR_CODES.has(code)) {
      return true;
    }
    const message = String(
      current?.error?.message ?? current?.message ?? ''
    ).toLowerCase();
    if (TRANSIENT_MESSAGE_KEYWORDS.some((kw) => message.includes(kw))) {
      return true;
    }
    current = current?.cause;
  }
  return false;
}

function usesVerbatimTranscript(model: string): boolean {
  return model === 'gemini-3.8-flash-tts' || model === 'gemini-3.8-flash-lite-tts';
}

export class GeminiTTSProvider implements ITTSProvider {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly maxRetries = 3,
    private readonly model = DEFAULT_GEMINI_TTS_MODEL
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
        const verbatimTranscript = usesVerbatimTranscript(this.model);
        // Gemini 3.8 may speak inline directions, so only narration belongs in text.
        const input = verbatimTranscript
          ? [{
              type: 'user_input',
              content: [{
                type: 'text',
                text,
                ...(trimmedStyle
                  ? { annotations: [{ type: 'speech_metadata', style: trimmedStyle }] }
                  : {}),
              }],
            }]
          : trimmedStyle
            ? `${trimmedStyle.startsWith('[') && trimmedStyle.endsWith(']') ? trimmedStyle : `[${trimmedStyle}]`}\n\n${text}`
            : text;

        const payload: any = {
          model: this.model,
          input,
          response_format: verbatimTranscript
            ? { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 }
            : { type: 'audio' },
          generation_config: {
            speech_config: [{ voice }],
          },
          stream: true,
        };

        const stream = await this.client.interactions.create(payload);

        const chunkBuffer: Uint8Array[] = [];
        for await (const event of stream as unknown as AsyncIterable<any>) {
          if (event.event_type === 'error') {
            const eventError: any = new Error(
              event.error?.message || 'Gemini TTS generation error from model'
            );
            if (event.error?.code !== undefined) eventError.code = event.error.code;
            if (event.error?.status !== undefined) eventError.status = event.error.status;
            throw eventError;
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
        if (!isRetryableGeminiTtsError(err) || attempt > this.maxRetries) {
          throw err;
        }
        await delay(calculateBackoffMs(attempt - 1));
      }
    }
  }
}
