export const ELEVENLABS_API_BASE_URL = 'https://api.elevenlabs.io';

/** Read the ElevenLabs key, accepting the ELEVEN_LABS_KEY alias that Studio also honors. */
export function elevenLabsApiKeyFromEnv(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env.ELEVENLABS_API_KEY || env.ELEVEN_LABS_KEY || undefined;
}

export class ElevenLabsRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    operation = 'TTS'
  ) {
    super(`ElevenLabs ${operation} request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ElevenLabsRequestError';
  }
}

/** Retry rate limits, server errors and network failures (fetch rejects with TypeError). */
export function isRetryableElevenLabsError(error: unknown): boolean {
  return error instanceof ElevenLabsRequestError
    ? error.status === 429 || error.status >= 500
    : error instanceof TypeError;
}

export async function readElevenLabsErrorDetail(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 300);
}
