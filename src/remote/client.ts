/**
 * A client for a connected mdmedia studio's `/api/v1`.
 *
 * The API key is attached to requests and nothing else: it never appears in
 * return values, errors, or logs, so a coding agent that runs the CLI sees
 * narration ids and links, never the credential.
 */

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

export class StudioClient {
  private readonly base: URL;

  constructor(url: string, private readonly apiKey: string | null = null, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = assertSafeStudioUrl(url);
  }

  get origin(): string {
    return this.base.origin;
  }

  private async request<T>(method: string, route: string, body?: unknown, authorized = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authorized) {
      if (!this.apiKey) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(route, this.base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new StudioApiError(0, 'unreachable', `Could not reach the studio at ${this.base.origin}. Is it running?`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* Not JSON. */ }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new StudioApiError(response.status, error?.code ?? `http_${response.status}`, error?.message ?? `The studio answered ${response.status}.`);
    }
    return parsed as T;
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

  revokeSelf(): Promise<void> {
    return this.request('DELETE', '/api/v1/keys/current');
  }

  /** Polls until the narration finishes or `timeoutMs` passes. */
  async waitForNarration(id: string, { timeoutMs = 15 * 60_000, intervalMs = 3000, onProgress }: {
    timeoutMs?: number; intervalMs?: number; onProgress?: (narration: NarrationResource) => void;
  } = {}): Promise<NarrationResource> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const narration = await this.narration(id);
      onProgress?.(narration);
      if (narration.status !== 'streaming') return narration;
      if (Date.now() + intervalMs > deadline) return narration;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
