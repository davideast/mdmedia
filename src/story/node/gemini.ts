import { GoogleGenAI } from '@google/genai';
import { calculateBackoffMs, delay } from '../../tts/backoff.js';
import { GeminiTTSProvider } from '../../tts/gemini-tts-provider.js';
import { SpeechRefused, type ImageBytes, type ImageModel, type Speaker, type TextModel, type Transcriber, type Vision, type VoiceJudge } from '../ports.js';
import { StoryError } from '../types.js';

export const DEFAULT_STORY_SPEECH_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_STORY_TRANSCRIBE_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_STORY_DIRECT_MODEL = 'gemini-3.5-flash';
export const DEFAULT_STORY_IMAGE_MODEL = 'gemini-3-pro-image';
export const DEFAULT_STORY_VISION_MODEL = 'gemini-3.5-flash';
export const DEFAULT_STORY_JUDGE_MODEL = 'gemini-3.5-flash';

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

/**
 * Scores an audition against a performance brief, for casting. In the voice
 * audition its scores ran 0 to 10 and its notes named what it heard ("a raspy
 * adult male" for a voice asked to be an eleven-year-old girl).
 */
export function createGeminiVoiceJudge(options: { apiKey: string; model?: string; maxRetries?: number }): VoiceJudge {
  const model = options.model ?? DEFAULT_STORY_JUDGE_MODEL;
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? 5;
  return {
    model,
    async score({ wav, brief, signal }) {
      const prompt =
        `You are casting a voice actor. Here is the performance brief:\n\n${brief}\n\nListen to the audition clip. Score each from 0 to 10, strictly:\n` +
        '- "who": does the apparent gender and age match the brief?\n- "accent": does the accent match?\n' +
        '- "texture": does the voice have the texture, resonance and rhythm described?\n- "fit": overall, would you cast this voice for this character?\n' +
        'Return JSON: {"who": n, "accent": n, "texture": n, "fit": n, "note": "one short sentence on what you hear"}.';
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } }, { text: prompt }] }],
            config: { responseMimeType: 'application/json' },
          });
          const r = JSON.parse(response.text ?? '{}') as Record<string, unknown>;
          const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
          return { who: n('who'), accent: n('accent'), texture: n('texture'), fit: n('fit'), note: String(r.note ?? '') };
        } catch (error) {
          if (attempt >= maxRetries || !(isBusy(error) || error instanceof SyntaxError)) throw error;
          await delay(calculateBackoffMs(attempt, 2000, 30_000));
        }
      }
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
    async transcribe(wav, { names = [], signal } = {}) {
      const prompt =
        'Transcribe this clip verbatim, exactly as spoken, including any words that sound like stage directions or speaker names. ' +
        (names.length ? `Names you may hear: ${names.join(', ')}. ` : '') +
        'Reply with the words only, or nothing if there is no speech.';
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
                { text: prompt },
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

/** The director's text model. */
export function createGeminiTextModel(options: { apiKey: string; model?: string; temperature?: number; maxRetries?: number }): TextModel {
  const model = options.model ?? DEFAULT_STORY_DIRECT_MODEL;
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? 5;
  return {
    model,
    async generate({ system, prompt, json, signal }) {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: system,
              temperature: options.temperature ?? 0.4,
              ...(json ? { responseMimeType: 'application/json' } : {}),
            },
          });
          const text = (response.text ?? '').trim();
          if (!text) throw new Error('The text model returned nothing.');
          return text;
        } catch (error) {
          if (attempt >= maxRetries || !isBusy(error)) throw error;
          await delay(calculateBackoffMs(attempt, 2000, 30_000));
        }
      }
    },
  };
}

const inline = (image: ImageBytes) => ({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } });

/** Panels and reference images on a Gemini image model; several references go in one request. */
export function createGeminiImageModel(options: { apiKey: string; model?: string; maxRetries?: number }): ImageModel {
  const model = options.model ?? DEFAULT_STORY_IMAGE_MODEL;
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? 4;
  return {
    model,
    async draw({ prompt, references, aspectRatio, signal }) {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [...references.map(inline), { text: prompt }] }],
            config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '1K' }, httpOptions: { timeout: 240_000 } },
          });
          const image = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
          if (!image?.data) throw new Error('Gemini returned no image.');
          return { bytes: new Uint8Array(Buffer.from(image.data, 'base64')), mimeType: image.mimeType ?? 'image/png' };
        } catch (error) {
          if (attempt >= maxRetries || !(isBusy(error) || /no image/i.test(messageOf(error)))) throw error;
          await delay(calculateBackoffMs(attempt, 3000, 45_000));
        }
      }
    },
  };
}

/** Yes/no checks and head boxes on a Gemini model that reads images. */
export function createGeminiVision(options: { apiKey: string; model?: string; maxRetries?: number }): Vision {
  const model = options.model ?? DEFAULT_STORY_VISION_MODEL;
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? 5;
  async function json(parts: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json' } });
        return JSON.parse(response.text ?? 'null');
      } catch (error) {
        if (attempt >= maxRetries || !(isBusy(error) || error instanceof SyntaxError)) throw error;
        await delay(calculateBackoffMs(attempt, 2000, 30_000));
      }
    }
  }
  return {
    model,
    async ask({ images, questions, signal }) {
      const parts = images.flatMap((image) => [{ text: `${image.label}:` }, inline(image)]);
      parts.push({ text: `Answer each question about the last image strictly, yes or no. Return JSON: an array of booleans in order.\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` });
      const answers = (await json(parts, signal)) as unknown[];
      return questions.map((_, i) => Array.isArray(answers) && answers[i] === true);
    },
    async heads({ image, characters, signal }) {
      const prompt =
        `Find the head of each of these characters in this comic panel, if visible:\n${characters.map((c) => `- ${c.id}: ${c.look}`).join('\n')}\n` +
        'Return JSON: [{"name": NAME, "box_2d": [ymin, xmin, ymax, xmax]}] with coordinates 0-1000, one entry per character whose head is visible, ' +
        'the box tight around the head and hair. Ignore everyone else.';
      const found = (await json([inline(image), { text: prompt }], signal)) as Array<{ name?: string; box_2d?: number[] }> | null;
      const ids = new Set(characters.map((c) => c.id));
      return (found ?? [])
        .filter((f) => f.name && ids.has(f.name.toUpperCase()) && f.box_2d?.length === 4)
        .map((f) => ({ id: f.name!.toUpperCase(), box: f.box_2d!.map((v) => v / 1000) as [number, number, number, number] }));
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
