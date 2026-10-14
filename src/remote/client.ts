/**
 * A client for a connected mdmedia studio's `/api/v1`.
 *
 * The API key is attached to requests and nothing else: it never appears in
 * return values, errors, or logs, so a coding agent that runs the CLI sees
 * narration ids and links, never the credential.
 */

import { randomUUID } from 'node:crypto';

export class StudioApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'StudioApiError';
  }
}

/** Only send a key where it cannot be read in transit: HTTPS, this machine, or a Tailscale (WireGuard) host. */
export function assertSafeStudioUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL. Pass the studio address, e.g. http://localhost:3000.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const tailnet = url.hostname.endsWith('.ts.net');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || tailnet))) return url;
  throw new Error(`Refusing to send credentials to ${url.origin} over ${url.protocol.replace(':', '')}. Use https, localhost, or a Tailscale address.`);
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; apiKey: string; key: { id: string; name: string } };

export interface NarrationResource {
  id: string;
  title: string;
  status: 'streaming' | 'ready' | 'error';
  visibility: string;
  durationMs: number;
  error: { code: string; message: string; hint: string | null } | null;
  links: { web: string; self: string; audio: string | null };
}

export interface CreatedNarration {
  id: string;
  status: 'streaming';
  visibility: string;
  /** Present when the request named a playlist; `position` counts from 1. */
  playlist?: { id: string; title: string; position: number } | { error: { code: string; message: string } };
  links: { web: string; self: string };
}

export type PlaylistPosition = 'start' | 'end' | { before: string } | { after: string };

export type PlaylistOp =
  | { add: string[]; at?: PlaylistPosition }
  | { remove: string[] }
  | { move: string; to: PlaylistPosition };

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  durationMs: number;
  counts: { ready: number; streaming: number; error: number; missing: number };
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  items: Array<{ id: string; title: string; status: string; durationMs: number; createdAt: number | null }>;
  /** Adds of items already there and removes of items not there. */
  unchanged?: string[];
}

export type StudioMediaType = 'image' | 'video' | 'music' | 'sfx';
/** Media that accept an uploaded reference image. */
export type ReferenceMediaType = Exclude<StudioMediaType, 'sfx'>;
export type GenerationStatus = 'queued' | 'generating' | 'ready' | 'error' | 'interrupted';

export interface StudioAsset {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  durationMs?: number;
  links: { content: string; thumbnail: string };
}

interface Adaptation { enabled?: boolean; instructions?: string }

/** Create bodies: only `prompt` is required; omitted options resolve from the account's defaults. */
export interface ImageRequestBody {
  prompt: string;
  adaptation?: Adaptation;
  output?: { aspectRatio?: string; resolution?: '1K' | '2K' | '4K' | null };
  referenceAssetId?: string | null;
}

export interface VideoRequestBody {
  prompt: string;
  adaptation?: Adaptation;
  output?: { aspectRatio?: '16:9' | '9:16'; resolution?: '360p' | '720p' | '1080p' | '4k'; durationSeconds?: number };
  referenceAssetId?: string | null;
  referenceRole?: 'first_frame' | 'reference';
}

export interface MusicRequestBody {
  prompt: string;
  adaptation?: Adaptation;
  output?: { mode?: 'song' | 'clip'; format?: 'mp3' | 'wav' };
  vocals?: 'auto' | 'vocals' | 'instrumental';
  lyrics?: string;
  referenceAssetId?: string | null;
}

export interface SfxRequestBody {
  prompt: string;
  output?: { format?: 'mp3' | 'wav'; durationSeconds?: number | null; loop?: boolean };
  promptInfluence?: number;
}

export interface StudioMediaBodies {
  image: ImageRequestBody;
  video: VideoRequestBody;
  music: MusicRequestBody;
  sfx: SfxRequestBody;
}

interface GenerationBase<T extends StudioMediaType> {
  id: string;
  itemId: string;
  type: T;
  title: string;
  status: GenerationStatus;
  phase: string;
  createdAt: number;
  updatedAt: number;
  /** The request as the studio resolved it, defaults filled in. */
  request: Required<StudioMediaBodies[T]>;
  preparedPrompt: string | null;
  provider: string;
  model: string;
  assets: StudioAsset[];
  error: { code: string; message: string } | null;
  links: { self: string; web: string };
}

export type ImageGeneration = GenerationBase<'image'>;
export interface VideoGeneration extends GenerationBase<'video'> {
  action: 'initial' | 'continue' | 'regenerate_latest';
  parentGenerationId: string | null;
  replacesGenerationId: string | null;
  clipNumber: number;
  /** The whole playable sequence; `clipDurationSeconds` is this attempt's clip. */
  durationSeconds: number | null;
  clipDurationSeconds: number | null;
}
export interface MusicGeneration extends GenerationBase<'music'> { lyrics: string | null; waveform: number[]; durationSeconds: number | null }
export interface SfxGeneration extends GenerationBase<'sfx'> { waveform: number[]; durationSeconds: number | null }

export interface StudioGenerations {
  image: ImageGeneration;
  video: VideoGeneration;
  music: MusicGeneration;
  sfx: SfxGeneration;
}

interface MediaResourceBase<T extends StudioMediaType> {
  id: string;
  type: T;
  title: string;
  status: GenerationStatus;
  visibility: 'private';
  createdAt: number;
  updatedAt: number;
  href: string;
  thumbnailAssetId: string | null;
  durationMs?: number;
  request: Required<StudioMediaBodies[T]>;
  latestGenerationId: string;
  latestSuccessfulGenerationId: string | null;
  latestGeneration: StudioGenerations[T] | null;
  /** The latest successful attempt; a failed retry never replaces it. */
  result: StudioGenerations[T] | null;
  links: { self: string; web: string; generations: string };
}

export type ImageResource = MediaResourceBase<'image'>;
export interface VideoResource extends MediaResourceBase<'video'> {
  /** Numbered ranges of the assembled movie in `result`. */
  clips: Array<{ index: number; generationId: string; startSeconds: number; endSeconds: number; thumbnail: string; content: string }>;
  canContinue: boolean;
}
export type MusicResource = MediaResourceBase<'music'>;
export type SfxResource = MediaResourceBase<'sfx'>;

export interface StudioMediaResources {
  image: ImageResource;
  video: VideoResource;
  music: MusicResource;
  sfx: SfxResource;
}
export type StudioMediaResource = StudioMediaResources[StudioMediaType];

export interface CreatedMedia<T extends StudioMediaType> {
  id: string;
  type: T;
  generation: StudioGenerations[T];
  links: { self: string; web: string; generations: string };
  /** True when this Idempotency-Key was already used, so no new attempt started. */
  replayed: boolean;
}

const MEDIA_ROUTES: Record<StudioMediaType, string> = { image: 'images', video: 'videos', music: 'music', sfx: 'sfx' };

/** The status of the attempt the item is working on, falling back to the item's own. */
export function mediaStatus(resource: StudioMediaResource): GenerationStatus {
  return resource.latestGeneration?.status ?? resource.status;
}

export const isFinished = (status: GenerationStatus) => status !== 'queued' && status !== 'generating';

export interface PollOptions<T> {
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (value: T) => void;
}

/** Failures that can pass on their own: the studio unreachable, restarting, or busy. */
const transient = (error: unknown) => error instanceof StudioApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

/** Failures after which a request may or may not have taken effect; 503 is the studio's own answer. */
const lostAnswer = (error: unknown) => error instanceof StudioApiError && [0, 500, 502, 504].includes(error.status);

/**
 * Reads until `done` or `timeoutMs` passes, then returns the last value read.
 * Generation continues on the server, so a read that fails transiently is
 * retried until the deadline; only a deadline with nothing read throws it.
 */
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, { timeoutMs = 15 * 60_000, intervalMs = 3000, onProgress }: PollOptions<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: { value: T } | null = null;
  for (;;) {
    const late = Date.now() + intervalMs > deadline;
    try {
      last = { value: await read() };
      onProgress?.(last.value);
      if (done(last.value) || late) return last.value;
    } catch (error) {
      if (!transient(error) || (late && !last)) throw error;
      if (late && last) return last.value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export class StudioClient {
  private readonly base: URL;

  constructor(url: string, private readonly apiKey: string | null = null, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = assertSafeStudioUrl(url);
  }

  get origin(): string {
    return this.base.origin;
  }

  /** Sends a request and returns the response, or throws the studio's `{ error }` as a StudioApiError. */
  private async send(method: string, route: string, { body, headers = {}, authorized = true }: {
    body?: BodyInit; headers?: Record<string, string>; authorized?: boolean;
  } = {}): Promise<Response> {
    const sent: Record<string, string> = { Accept: 'application/json', ...headers };
    if (authorized) {
      if (!this.apiKey) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
      sent.Authorization = `Bearer ${this.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(route, this.base), { method, headers: sent, body });
    } catch {
      throw new StudioApiError(0, 'unreachable', `Could not reach the studio at ${this.base.origin}. Is it running?`);
    }
    if (response.ok) return response;
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* Not JSON. */ }
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new StudioApiError(response.status, error?.code ?? `http_${response.status}`, error?.message ?? `The studio answered ${response.status}.`);
  }

  private async request<T>(method: string, route: string, body?: unknown, authorized = true, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.send(method, route, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      authorized,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    try { return (text ? JSON.parse(text) : null) as T; } catch { return null as T; }
  }

  startDevice(clientName: string): Promise<DeviceStart> {
    return this.request('POST', '/api/v1/device', { clientName }, false);
  }

  pollDevice(deviceCode: string): Promise<DevicePoll> {
    return this.request('POST', '/api/v1/device/token', { deviceCode }, false);
  }

  options(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/options');
  }

  createNarration(body: Record<string, unknown>): Promise<CreatedNarration> {
    return this.request('POST', '/api/v1/narrations', body);
  }

  narrations(query: { q?: string; status?: string; limit?: number } = {}): Promise<{ narrations: NarrationResource[] }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request('GET', `/api/v1/narrations${params.size ? `?${params}` : ''}`);
  }

  playlists(): Promise<{ playlists: PlaylistSummary[] }> {
    return this.request('GET', '/api/v1/playlists');
  }

  playlist(id: string): Promise<PlaylistDetail> {
    return this.request('GET', `/api/v1/playlists/${encodeURIComponent(id)}`);
  }

  createPlaylist(body: { title: string; description?: string; narrationIds?: string[] }): Promise<PlaylistDetail> {
    return this.request('POST', '/api/v1/playlists', body);
  }

  updatePlaylist(id: string, patch: { title?: string; description?: string }): Promise<PlaylistDetail> {
    return this.request('PATCH', `/api/v1/playlists/${encodeURIComponent(id)}`, patch);
  }

  editPlaylist(id: string, ops: PlaylistOp[]): Promise<PlaylistDetail> {
    return this.request('POST', `/api/v1/playlists/${encodeURIComponent(id)}/items`, { ops });
  }

  reorderPlaylist(id: string, order: string[]): Promise<PlaylistDetail> {
    return this.request('PUT', `/api/v1/playlists/${encodeURIComponent(id)}/items`, { order });
  }

  deletePlaylist(id: string): Promise<void> {
    return this.request('DELETE', `/api/v1/playlists/${encodeURIComponent(id)}`);
  }

  /** A playlist id from an id or an exact title (ignoring case). */
  async resolvePlaylist(idOrTitle: string): Promise<PlaylistSummary> {
    const { playlists } = await this.playlists();
    const byId = playlists.find((playlist) => playlist.id === idOrTitle);
    if (byId) return byId;
    const wanted = idOrTitle.trim().toLowerCase();
    const matches = playlists.filter((playlist) => playlist.title.trim().toLowerCase() === wanted);
    if (matches.length > 1) throw new StudioApiError(409, 'playlist_ambiguous', `${matches.length} playlists are titled "${idOrTitle}". Use the id: ${matches.map((playlist) => playlist.id).join(', ')}.`);
    if (!matches[0]) throw new StudioApiError(404, 'playlist_not_found', `No playlist with the id or title "${idOrTitle}".`);
    return matches[0];
  }

  narration(id: string): Promise<NarrationResource> {
    return this.request('GET', `/api/v1/narrations/${encodeURIComponent(id)}`);
  }

  async audio(id: string): Promise<Uint8Array> {
    if (!this.apiKey) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
    const response = await this.fetchImpl(new URL(`/api/v1/narrations/${encodeURIComponent(id)}/audio`, this.base), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new StudioApiError(response.status, body?.error?.code ?? `http_${response.status}`, body?.error?.message ?? 'Could not download the audio.');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Starts a media item. Each call sends a fresh Idempotency-Key unless the caller
   * passes one. A create whose answer was lost is retried with the same key, so the
   * studio replays the first attempt instead of starting, and charging for, another.
   */
  async createMedia<T extends StudioMediaType>(type: T, body: StudioMediaBodies[T], idempotencyKey: string = randomUUID(), retryDelaysMs: readonly number[] = [1000, 4000]): Promise<CreatedMedia<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<CreatedMedia<T>>('POST', `/api/v1/${MEDIA_ROUTES[type]}`, body, true, { 'Idempotency-Key': idempotencyKey });
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined || !lostAnswer(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  createImage(body: ImageRequestBody, idempotencyKey?: string): Promise<CreatedMedia<'image'>> {
    return this.createMedia('image', body, idempotencyKey);
  }

  createVideo(body: VideoRequestBody, idempotencyKey?: string): Promise<CreatedMedia<'video'>> {
    return this.createMedia('video', body, idempotencyKey);
  }

  createMusic(body: MusicRequestBody, idempotencyKey?: string): Promise<CreatedMedia<'music'>> {
    return this.createMedia('music', body, idempotencyKey);
  }

  createSfx(body: SfxRequestBody, idempotencyKey?: string): Promise<CreatedMedia<'sfx'>> {
    return this.createMedia('sfx', body, idempotencyKey);
  }

  media<T extends StudioMediaType>(type: T, id: string): Promise<StudioMediaResources[T]> {
    return this.request('GET', `/api/v1/${MEDIA_ROUTES[type]}/${encodeURIComponent(id)}`);
  }

  /** Uploads a PNG, JPEG, or WebP reference as raw bytes, scoped to the medium that will use it. */
  async uploadReference(media: ReferenceMediaType, bytes: Uint8Array, mimeType: string): Promise<StudioAsset> {
    const response = await this.send('POST', `/api/v1/assets?media=${media}`, { body: new Uint8Array(bytes), headers: { 'Content-Type': mimeType } });
    return await response.json() as StudioAsset;
  }

  /**
   * Opens an asset link from a resource as a stream, so a large video never has
   * to fit in memory. Only its path is used, resolved against this studio, so
   * the key never follows a link to another host.
   */
  async downloadAsset(link: string): Promise<{ body: ReadableStream<Uint8Array>; mimeType: string }> {
    let url: URL | null = null;
    try { url = new URL(link, this.base); } catch { /* Not a URL. */ }
    if (!url?.pathname.startsWith('/api/v1/')) throw new StudioApiError(400, 'invalid_asset_link', 'That is not a studio asset link.');
    const response = await this.send('GET', `${url.pathname}${url.search}`, { headers: { Accept: '*/*' } });
    if (!response.body) throw new StudioApiError(502, 'empty_asset', 'The studio sent an empty file.');
    return { body: response.body, mimeType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** Polls until the item's latest attempt finishes or `timeoutMs` passes. */
  waitForMedia<T extends StudioMediaType>(type: T, id: string, options: PollOptions<StudioMediaResources[T]> = {}): Promise<StudioMediaResources[T]> {
    return poll(() => this.media(type, id), (resource) => isFinished(mediaStatus(resource)), options);
  }

  revokeSelf(): Promise<void> {
    return this.request('DELETE', '/api/v1/keys/current');
  }

  /** Polls until the narration finishes or `timeoutMs` passes. */
  waitForNarration(id: string, options: PollOptions<NarrationResource> = {}): Promise<NarrationResource> {
    return poll(() => this.narration(id), (narration) => narration.status !== 'streaming', options);
  }
}
