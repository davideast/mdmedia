import { GoogleGenAI } from '@google/genai';
import { calculateBackoffMs, delay } from '../../tts/backoff.js';
import { GeminiTTSProvider } from '../../tts/gemini-tts-provider.js';
import { SpeechRefused, type Speaker, type Transcriber } from '../ports.js';
import { StoryError } from '../types.js';

export const DEFAULT_STORY_SPEECH_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_STORY_TRANSCRIBE_MODEL = 'gemini-3.5-flash-lite';

/**
 * Speech on a verbatim Gemini TTS model: the words and the delivery note go in
 * separate fields, so the note is never spoken. Input-filter refusals become
 * SpeechRefused so the build can fall back to a shorter note.
 */
export function createGeminiSpeaker(options: { apiKey: string; model?: string; maxRetries?: number }): Speaker {
  const model = options.model ?? DEFAULT_STORY_SPEECH_MODEL;
  const provider = new GeminiTTSProvider(new GoogleGenAI({ apiKey: options.apiKey }), options.maxRetries ?? 4, model);
  return {
    provider: { name: 'gemini', model },
    async speak({ text, voice, note, signal }) {
      if (typeof voice !== 'string' && voice.provider !== 'gemini') {
        throw new StoryError('unsupported-voice', `Story builds speak with Gemini voices; ${voice.provider} voices are not supported yet.`);
      }
      const name = typeof voice === 'string' ? voice : voice.id;
      const chunks: Uint8Array[] = [];
      try {
        for await (const chunk of provider.streamAudio(text, name, note)) {
          signal?.throwIfAborted();
          chunks.push(chunk);
        }
      } catch (error) {
        if (isRefusal(error)) throw new SpeechRefused(messageOf(error));
        throw error;
      }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
      if (!out.byteLength) throw new Error('Gemini returned no audio for a line.');
      return out;
    },
  };
}

/** Transcribes one clip at a time; batching clips made answers drift. */
export function createGeminiTranscriber(options: { apiKey: string; model?: string; maxRetries?: number }): Transcriber {
  const model = options.model ?? DEFAULT_STORY_TRANSCRIBE_MODEL;
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? 5;
  return {
    model,
    async transcribe(wav, signal) {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
                { text: 'Transcribe this clip verbatim, exactly as spoken, including any words that sound like stage directions or speaker names. Reply with the words only, or nothing if there is no speech.' },
              ],
            }],
          });
          return (response.text ?? '').trim();
        } catch (error) {
          if (attempt >= maxRetries || !isBusy(error)) throw error;
          await delay(calculateBackoffMs(attempt, 2000, 30_000));
        }
      }
    },
  };
}

/** The input filter's refusal: HTTP 400 with code prohibited_content. */
export function isRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; message?: unknown; error?: unknown; cause?: unknown };
    if (e.code === 'prohibited_content' || /input blocked|prohibited/i.test(String(e.message ?? ''))) return true;
    current = e.error ?? e.cause;
  }
  return false;
}

function isBusy(error: unknown): boolean {
  const status = Number((error as { status?: unknown })?.status ?? 0);
  return status === 429 || status === 408 || (status >= 500 && status < 600) || /fetch failed|timeout|aborted/i.test(messageOf(error));
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}
