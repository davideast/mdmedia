import { AlignerUnavailableError, type Aligner, type AlignerAudio, type Alignment } from '../cut/words.js';
import { calculateBackoffMs, delay } from '../tts/backoff.js';
import {
  ELEVENLABS_API_BASE_URL,
  ElevenLabsRequestError,
  elevenLabsApiKeyFromEnv,
  isRetryableElevenLabsError,
  readElevenLabsErrorDetail,
} from './request-error.js';

/** One word from ElevenLabs forced alignment, in seconds from the start of the uploaded audio. */
export interface ForcedAlignmentWord {
  text: string;
  start: number;
  end: number;
  /** Absent when ElevenLabs gives none. */
  loss?: number;
}

export interface ForcedAlignmentResult {
  /** Spoken words only: the whitespace entries ElevenLabs returns between words are dropped. */
  words: ForcedAlignmentWord[];
  /** The overall loss: lower is a closer fit. Absent when ElevenLabs gives none. */
  loss?: number;
}

export interface ForcedAlignmentOptions {
  apiKey: string;
  /** The audio's MIME type. Default `audio/wav`. */
  mimeType?: string;
  /** The uploaded file's name. Default `audio.wav`. */
  fileName?: string;
  maxRetries?: number;
  request?: typeof fetch;
}

const OPERATION = 'forced alignment';

export const MISSING_KEY_MESSAGE =
  'An ElevenLabs API key is required for forced alignment. Set ELEVENLABS_API_KEY (or ELEVEN_LABS_KEY).';

/** The ElevenLabs API key lacks a permission, e.g. forced_alignment. */
export class ElevenLabsMissingPermissionError extends ElevenLabsRequestError {
  constructor(status: number, detail: string) {
    super(status, detail, OPERATION);
    this.name = 'ElevenLabsMissingPermissionError';
    this.message = `This ElevenLabs API key doesn't have the forced_alignment permission. Turn it on for the key in ElevenLabs (Developers → API keys), then run again. (HTTP ${status}${detail ? `: ${detail}` : ''})`;
  }
}

function isMissingPermission(status: number, detail: string): boolean {
  if (status !== 401 && status !== 403) return false;
  try {
    const body: unknown = JSON.parse(detail);
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const inner = (body as { detail: unknown }).detail;
      if (typeof inner === 'object' && inner !== null && 'status' in inner) {
        return (inner as { status: unknown }).status === 'missing_permissions';
      }
    }
  } catch {
    // Not JSON; fall through to the text check.
  }
  return detail.includes('missing_permissions');
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readResult(body: unknown): ForcedAlignmentResult {
  const bad = (what: string): never => {
    throw new Error(`ElevenLabs ${OPERATION} returned an unexpected response: ${what}`);
  };
  if (typeof body !== 'object' || body === null) return bad('not an object');
  const { words, loss } = body as { words?: unknown; loss?: unknown };
  if (!Array.isArray(words)) return bad('no words');
  const spoken: ForcedAlignmentWord[] = [];
  for (const w of words) {
    if (typeof w !== 'object' || w === null) return bad('a word is not an object');
    const { text, start, end, loss: wordLoss } = w as Record<string, unknown>;
    if (typeof text !== 'string' || !isNum(start) || !isNum(end)) return bad('a word has no text, start or end');
    if (text.trim() === '') continue;
    spoken.push(isNum(wordLoss) ? { text, start, end, loss: wordLoss } : { text, start, end });
  }
  return isNum(loss) ? { words: spoken, loss } : { words: spoken };
}

/**
 * Aligns a known transcript to audio with ElevenLabs forced alignment
 * (`POST /v1/forced-alignment`), returning when each spoken word starts and ends.
 * Rate limits, server errors and network failures are retried.
 */
export async function forcedAlignment(
  audio: Uint8Array,
  text: string,
  options: ForcedAlignmentOptions,
): Promise<ForcedAlignmentResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  if (!text.trim()) throw new Error('Forced alignment needs the text that is spoken.');
  if (audio.byteLength === 0) throw new Error('Forced alignment needs some audio.');
  const request = options.request ?? fetch;
  const maxRetries = options.maxRetries ?? 2;

  for (let attempt = 0; ; attempt++) {
    try {
      const form = new FormData();
      const bytes = new Uint8Array(audio.byteLength);
      bytes.set(audio);
      form.append('file', new Blob([bytes], { type: options.mimeType ?? 'audio/wav' }), options.fileName ?? 'audio.wav');
      form.append('text', text);
      const response = await request(`${ELEVENLABS_API_BASE_URL}/v1/forced-alignment`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
      });
      if (!response.ok) {
        const detail = await readElevenLabsErrorDetail(response);
        if (isMissingPermission(response.status, detail)) throw new ElevenLabsMissingPermissionError(response.status, detail);
        throw new ElevenLabsRequestError(response.status, detail, OPERATION);
      }
      return readResult(await response.json());
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableElevenLabsError(error)) throw error;
      await delay(calculateBackoffMs(attempt));
    }
  }
}

/** The `Aligner` backed by ElevenLabs forced alignment. */
export class ElevenLabsAligner implements Aligner {
  readonly name = 'elevenlabs';

  constructor(
    private readonly apiKey: string,
    private readonly options: Omit<ForcedAlignmentOptions, 'apiKey'> = {},
  ) {
    if (!apiKey.trim()) throw new AlignerUnavailableError(MISSING_KEY_MESSAGE);
  }

  /** An aligner with the key from ELEVENLABS_API_KEY or ELEVEN_LABS_KEY. */
  static fromEnv(env: Record<string, string | undefined> = process.env, options?: Omit<ForcedAlignmentOptions, 'apiKey'>): ElevenLabsAligner {
    return new ElevenLabsAligner(elevenLabsApiKeyFromEnv(env) ?? '', options);
  }

  async align(audio: AlignerAudio, text: string): Promise<Alignment> {
    try {
      return await forcedAlignment(audio.bytes, text, { ...this.options, apiKey: this.apiKey });
    } catch (error) {
      // A bad key or a missing permission fails every line the same way.
      if (error instanceof ElevenLabsMissingPermissionError || (error instanceof ElevenLabsRequestError && error.status === 401)) {
        throw new AlignerUnavailableError(error.message, { cause: error });
      }
      throw error;
    }
  }
}
