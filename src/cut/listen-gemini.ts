import { GoogleGenAI, Type } from '@google/genai';
import { ListenerUnavailableError, type ListenAnswer, type Listener, type Listening, type ListenRequest } from './listen.js';

/**
 * The listening check on Gemini, ported from the CRT TV production's
 * `judge.mjs`: the clip goes to the model inline with the known facts and the
 * questions, and comes back as structured answers. `gemini-3.8-flash` hears
 * audio; the lite models and `gemini-4-argon` don't, so they can't be used.
 */

/** The model that hears the soundtrack. */
export const GEMINI_LISTEN_MODEL = 'gemini-3.8-flash';

/** The part of the Gemini client this uses, so tests can stand in for it. */
export interface GeminiContentClient {
  models: {
    generateContent(request: {
      model: string;
      contents: Array<{ role: string; parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }>;
      config: { responseMimeType: string; responseSchema: unknown };
    }): Promise<{ text?: string }>;
  };
}

export interface GeminiListenerOptions {
  model?: string;
  /** Tries per request; only an overloaded model (503) is retried. Default 5. */
  attempts?: number;
  /** Waits `backoff × attempt` ms between tries. Default 4000. */
  backoff?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    canHearAudio: { type: Type.BOOLEAN },
    answers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          verdict: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          heard: { type: Type.STRING },
          why: { type: Type.STRING },
        },
        required: ['id', 'verdict', 'confidence', 'heard', 'why'],
      },
    },
  },
  required: ['canHearAudio', 'answers'],
};

/** The prompt judge.mjs sent: trust the facts, answer only from what is heard, keep verdicts short. */
export function listenPrompt(request: Pick<ListenRequest, 'facts' | 'questions'>): string {
  return `You are checking the delivery in this video clip by listening to its soundtrack and watching it.
${request.facts ? `Known facts (exact; trust these over your own estimates):\n${request.facts}\n` : ''}
Answer each question only from what you actually hear and see. Keep verdicts short and plain ("yes", "no", "one continuous delivery", "two separate deliveries", or a short phrase). Give a confidence from 0 to 1, describe what you heard, and say why. If you can't tell, say "can't tell".

Questions:
${request.questions.map((q) => `- [${q.id}] ${q.ask}`).join('\n')}`;
}

function isOverloaded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /503|UNAVAILABLE|overloaded|high demand/i.test(message);
}

function isUnauthorized(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|\b401\b|\b403\b/i.test(message);
}

function readAnswers(text: string): { canHearAudio: boolean; answers: ListenAnswer[] } {
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null) throw new Error('the listener returned no answers');
  const o = json as { canHearAudio?: unknown; answers?: unknown };
  const answers = Array.isArray(o.answers) ? o.answers : [];
  return {
    canHearAudio: o.canHearAudio === true,
    answers: answers.map((a: unknown) => {
      const x = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
      return {
        id: String(x.id ?? ''),
        verdict: String(x.verdict ?? ''),
        confidence: typeof x.confidence === 'number' ? x.confidence : 0,
        heard: String(x.heard ?? ''),
        why: String(x.why ?? ''),
      };
    }),
  };
}

export class GeminiListener implements Listener {
  readonly name: string;
  private readonly model: string;
  private readonly attempts: number;
  private readonly backoff: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly client: GeminiContentClient, options: GeminiListenerOptions = {}) {
    this.model = options.model ?? GEMINI_LISTEN_MODEL;
    this.name = `gemini:${this.model}`;
    this.attempts = options.attempts ?? 5;
    this.backoff = options.backoff ?? 4000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** A listener with the key from GEMINI_API_KEY. */
  static fromEnv(env: Record<string, string | undefined> = process.env, options: GeminiListenerOptions = {}): GeminiListener {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new ListenerUnavailableError('The listening check needs a Gemini API key. Set GEMINI_API_KEY.');
    return new GeminiListener(new GoogleGenAI({ apiKey }) as unknown as GeminiContentClient, { ...options, model: options.model ?? env.MDMEDIA_LISTEN_MODEL });
  }

  async listen(request: ListenRequest): Promise<Listening> {
    const data = Buffer.from(request.clip.bytes).toString('base64');
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: request.clip.mimeType, data } }, { text: listenPrompt(request) }] }],
          config: { responseMimeType: 'application/json', responseSchema: SCHEMA },
        });
        const { canHearAudio, answers } = readAnswers(response.text ?? '');
        return { model: this.model, canHearAudio, answers };
      } catch (error) {
        if (isUnauthorized(error)) throw new ListenerUnavailableError(`Gemini refused the request: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        if (attempt >= this.attempts || !isOverloaded(error)) throw error;
        await this.sleep(this.backoff * attempt);
      }
    }
  }
}
