export interface ImageHttpOptions {
  request?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** No submission retries: a transport failure may still have created a billable job. */
export class ImageHttpClient {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly request: typeof fetch;

  constructor(options: ImageHttpOptions = {}) {
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) throw new Error('Image timeouts and poll intervals must be positive.');
  }

  async json(url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<{ body: any; requestId?: string }> {
    const response = await this.fetch(url, init, timeoutMs);
    let body: any;
    try { body = await response.json(); } catch { throw new Error(`Image API returned invalid JSON (HTTP ${response.status}).`); }
    const requestId = response.headers.get('x-request-id') ?? body.request_id ?? body.error?.request_id;
    if (!response.ok) {
      const code = body.error?.code ?? body.code ?? 'request_failed';
      throw new Error(`Image API HTTP ${response.status}: ${code}${requestId ? ` (request ${requestId})` : ''}. No submission retry was made.`);
    }
    return { body, requestId };
  }

  async download(url: string, timeoutMs = this.timeoutMs): Promise<Uint8Array> {
    if (new URL(url).protocol !== 'https:') throw new Error('Image download URL must use HTTPS.');
    // Never forward generation credentials to a hosted output URL.
    const response = await this.fetch(url, {}, timeoutMs);
    if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async fetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await this.request(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) });
    } catch {
      throw new Error('Image API transport failed or timed out. Submission was not retried; it may already have been charged.');
    }
  }
}
