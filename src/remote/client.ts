/**
 * A client for a connected mdmedia studio's `/api/v1`.
 *
 * The API key is attached to requests and nothing else: it never appears in
 * return values, errors, or logs, so a coding agent that runs the CLI sees
 * narration ids and links, never the credential.
 */

import { randomUUID } from 'node:crypto';
import type { AgentHeartbeat, ContextBundle, Decision, DecisionSource, Message, Suggestion, SuggestionCheck, SuggestionState, Thread, ThreadStatus, TimedRef } from '../threads/types.js';

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
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

export type CutStatus = 'review' | 'approved' | 'final' | 'none';
export type CutKind = 'cut' | 'rendered';
/** What a production asset is, as a cut uses it. */
export type ProductionMediaType = 'video' | 'image' | 'voice' | 'music' | 'sfx';

export interface ProductionCutSummary {
  id: string;
  label: string;
  status: CutStatus;
  kind: CutKind;
  lengthSeconds: number | null;
  createdAt: number;
  order: number;
  renderedAssetId: string | null;
  /** A still from the finished video, for listings. */
  posterAssetId?: string | null;
  /** The review note, shortened for listings when `notesTruncated`. */
  notes?: string;
  notesTruncated?: boolean;
  links: { self: string; rendered: string | null };
}

export interface ProductionSummary {
  id: string;
  slug: string;
  title: string;
  series: { id: string; title: string } | null;
  coverAssetId: string | null;
  currentCutId: string | null;
  approvedCutId: string | null;
  cutCount: number;
  cuts: ProductionCutSummary[];
  /** Who plays whom (absent from studios older than characters). */
  cast?: ProductionCastMember[];
  createdAt: number;
  updatedAt: number;
  /** The latest of its newest cut and its last review. */
  activityAt?: number;
  links: { self: string; cover: string | null; coverThumbnail: string | null };
}

export interface ProductionList {
  productions: ProductionSummary[];
  series: Array<{ id: string; title: string; slug: string; productionIds: string[] }>;
}

export interface ProductionAsset {
  id: string;
  mediaType: ProductionMediaType;
  mimeType: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  durationMs?: number;
  links: { content: string; thumbnail: string | null };
}

/** One part of a production's cast, as the studio stores it. */
export interface ProductionCastMember {
  role: string;
  characterId: string;
  slug: string;
  version: number;
  /** `rick@1`. */
  ref: string;
  name: string;
  description: string;
  register: string;
  voice: string;
  stillAssetId: string | null;
  referenceLines: number;
}

/** The body of `POST /api/v1/productions`: create or update the production with this slug. */
export interface ProductionUpsert {
  slug: string;
  title: string;
  series?: { title: string; slug?: string } | null;
  coverAssetId?: string | null;
  /** Who plays whom: each character version must be stored first. Left out keeps the cast; `[]` clears it. */
  cast?: Array<{ role: string; character: string }>;
}

/** The body of `PUT /api/v1/characters/{slug}/versions/{version}`: the character file, and the asset each still was uploaded as. */
export interface CharacterVersionBody {
  character: unknown;
  stills: Record<string, string>;
}

export interface CharacterVersionResource {
  id: string;
  slug: string;
  version: number;
  ref: string;
  character: unknown;
  stills: Record<string, string>;
  createdAt: number;
  links: { self: string; character: string; stills: Record<string, { content: string; thumbnail: string }> };
}

export interface CharacterSummary {
  id: string;
  slug: string;
  name: string;
  kind: 'person' | 'thing';
  latestVersion: number;
  versions: Array<{ version: number; date: string; changes: string; createdAt: number }>;
  createdAt: number;
  updatedAt: number;
  links: { self: string };
}

export interface ProductionPatch {
  title?: string;
  coverAssetId?: string | null;
  approvedCutId?: string | null;
  currentCutId?: string | null;
  cuts?: Array<{ id: string; status?: CutStatus; label?: string; notes?: string }>;
}

/** The body of `PUT /api/v1/productions/{id}/cuts/{cutId}`. `cut` and `words` are JSON as the cut format defines them. */
export interface ProductionCutBody {
  label: string;
  status: CutStatus;
  kind: CutKind;
  notes?: string;
  order: number;
  createdAt?: number;
  cut?: unknown;
  words?: unknown;
  renderedAssetId?: string | null;
  /** An image asset: a still from the finished video, for listings. */
  posterAssetId?: string | null;
  thumbs?: Record<string, string>;
  source?: { cut?: string; rendered?: string } | null;
  lengthSeconds?: number | null;
}

export interface ProductionCutResource extends Omit<ProductionCutBody, 'cut' | 'words'> {
  id: string;
  productionId: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  lengthSeconds: number | null;
  renderedAssetId: string | null;
  thumbs: Record<string, string>;
  cut: unknown;
  words: unknown;
  /** The resolved timeline (`mdmedia/cut`'s `Timeline`), words applied; null for a rendered cut or one that doesn't resolve. */
  timeline: unknown;
  wordsSummary: { applied: string[]; stale: Array<{ id: string; reason: string }>; unchecked: string[] } | null;
  errors: Array<{ code: string; message: string }>;
  assets: Record<string, ProductionAsset>;
  links: { self: string; production: string; rendered: string | null };
}

/** A file to upload as production media. `body` is read lazily, so a large take never has to fit in memory. */
export interface ProductionMediaUpload {
  sha256: string;
  mediaType: ProductionMediaType;
  mimeType: string;
  byteLength: number;
  body: Blob;
  durationMs?: number;
  width?: number;
  height?: number;
}

/** A thread as the API returns it: the stored thread, its one status line, and whether an agent should pick it up. */
export interface ThreadResource extends Thread {
  statusLine: { tone: string; text: string };
  needsAgent: boolean;
  links: { self: string; context: string };
}

export interface ThreadDetail {
  thread: ThreadResource;
  messages: Message[];
  suggestions: Suggestion[];
}

/** The body of a reply. `at` names a video and a time on it; a time on a cut is anchored by the studio. */
export interface MessageBody {
  text: string;
  agent?: string;
  replyTo?: string;
  at?: { video: TimedRef['video']; time: number };
  version?: { cutId: string };
  keepClaim?: boolean;
}

/** One option, as an agent sends it, its previews already uploaded as production media. */
export interface SuggestionBody {
  title: string;
  approach?: string;
  steps?: string[];
  cost?: { generations?: number; minutes?: number };
  risks?: string[];
  checks?: SuggestionCheck[];
  previews?: Array<{ assetId: string; label?: string }>;
  keeps?: string[];
  overturns?: string[];
  creates?: string[];
  revises?: string;
}

export interface SuggestionsBody {
  suggestions: SuggestionBody[];
  /** What the agent read and recommends; it offers the options. */
  message: string;
  agent?: string;
  round?: number;
}

export interface DecisionBody {
  text: string;
  id?: string;
  kind?: 'decision' | 'constraint';
  take?: string;
  source?: DecisionSource;
  quote?: string;
  revised?: string;
  threadIds?: string[];
  cutIds?: string[];
}

export type TreeId = string;
export type TreeNodeId = string;
export type TreeDocId = string;

export interface TreeMediaRef {
  type: StudioMediaType | 'asset' | 'mermaid';
  id: string;
  generationId?: string;
}

export interface TreeNodeMeta {
  id: TreeNodeId;
  kind: 'folder' | 'doc';
  name: string;
  path: string;
  previousPaths: string[];
  parentId: TreeNodeId | null;
  childIds: TreeNodeId[];
  docId: TreeDocId | null;
  narrationId: string | null;
  narrationStatus: 'unvoiced' | 'streaming' | 'ready' | 'error';
  narrationContentHash: string | null;
  updatedAt: number;
}

export interface TreeSelectionSet {
  id: string;
  title: string;
  nodeIds: TreeNodeId[];
  instructions?: string;
  updatedAt: number;
}

export interface TreeSummary {
  id: TreeId;
  title: string;
  description: string;
  nodeCount: number;
  docCount: number;
  selectedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TreeDetail extends TreeSummary {
  rootIds: TreeNodeId[];
  nodes: Record<TreeNodeId, TreeNodeMeta>;
  selectedNodeIds: TreeNodeId[];
  selectionSets: Record<string, TreeSelectionSet>;
  pathAssets: Record<string, TreeMediaRef>;
  revision: number;
}

export interface TreeDocument {
  id: TreeDocId;
  treeId: TreeId;
  nodeId: TreeNodeId;
  path: string;
  title: string;
  markdown: string;
  contentHash: string;
  narrationId: string | null;
  narrationStatus: 'unvoiced' | 'streaming' | 'ready' | 'error';
  narrationStale: boolean;
  updatedAt: number;
}

export type TreePosition = 'start' | 'end' | { before: TreeNodeId } | { after: TreeNodeId };

export interface TreeOrganizeEntry {
  path: string;
  nodeId?: TreeNodeId;
  target?: string;
  title?: string;
  children?: TreeOrganizeEntry[];
}

export type TreeOp =
  | {
      op: 'put_doc';
      path: string;
      title?: string;
      markdown: string;
      at?: TreePosition;
      nodeId?: TreeNodeId;
    }
  | { op: 'mkdir'; path: string; at?: TreePosition; nodeId?: TreeNodeId }
  | { op: 'move'; target: string; toPath: string; at?: TreePosition }
  | { op: 'reorder'; folderPath: string; childOrder: string[] }
  | { op: 'remove'; targets: string[]; recursive?: boolean }
  | { op: 'select'; targets: string[]; mode: 'set' | 'add' | 'remove' | 'clear' }
  | { op: 'save_selection_set'; id?: string; title: string; targets: string[]; instructions?: string }
  | { op: 'delete_selection_set'; id: string }
  | { op: 'bind_asset'; virtualPath: string; ref: TreeMediaRef }
  | {
      op: 'replace_media_ref';
      nodeId: TreeNodeId;
      from: TreeMediaRef;
      to: TreeMediaRef;
      placement: 'replace' | 'insert_below';
    }
  | { op: 'organize'; entries: TreeOrganizeEntry[] };

export interface TreeCompileRequest {
  targets?: string[];
  preset?: string;
  mode?: 'concat' | 'synthesize';
  title?: string;
  instructions?: string;
  saveAsPath?: string;
  narrate?: boolean;
  voice?: string;
}

export interface TreeCompileResult {
  title: string;
  markdown: string;
  sourceNodeIds: TreeNodeId[];
  savedNode?: TreeNodeMeta;
  narrationId?: string;
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
  model?: string | null;
  adaptation?: Adaptation;
  output?: {
    aspectRatio?: string;
    resolution?: '0.5K' | '1K' | '2K' | '4K' | null;
    mimeType?: 'image/png' | 'image/jpeg' | null;
  };
  referenceAssetId?: string | null;
  referenceAssetIds?: string[];
  videoUri?: string | null;
  searchGrounding?: { web?: boolean; imageSearch?: boolean } | null;
  thinkingLevel?: 'minimal' | 'medium' | 'high' | null;
  action?: 'initial' | 'refine' | 'regenerate';
  fromGenerationId?: string | null;
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

export interface ImageGeneration extends GenerationBase<'image'> {
  interactionId?: string | null;
  parentGenerationId?: string | null;
  thoughtSummary?: string | null;
  grounding?: {
    citations: Array<{ url: string; title?: string }>;
    searchSuggestionsHtml?: string | null;
  } | null;
}
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
    const error = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new StudioApiError(response.status, error?.code ?? `http_${response.status}`, error?.message ?? `The studio answered ${response.status}.`, error?.details);
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

  productions(): Promise<ProductionList> {
    return this.request('GET', '/api/v1/productions');
  }

  production(id: string): Promise<ProductionSummary> {
    return this.request('GET', `/api/v1/productions/${encodeURIComponent(id)}`);
  }

  /** Creates or updates the production with `body.slug`. */
  upsertProduction(body: ProductionUpsert): Promise<ProductionSummary> {
    return this.request('POST', '/api/v1/productions', body);
  }

  updateProduction(id: string, patch: ProductionPatch): Promise<ProductionSummary> {
    return this.request('PATCH', `/api/v1/productions/${encodeURIComponent(id)}`, patch);
  }

  deleteProduction(id: string): Promise<void> {
    return this.request('DELETE', `/api/v1/productions/${encodeURIComponent(id)}`);
  }

  productionCut(id: string, cutId: string): Promise<ProductionCutResource> {
    return this.request('GET', `/api/v1/productions/${encodeURIComponent(id)}/cuts/${encodeURIComponent(cutId)}`);
  }

  /** Replaces the cut with this id, or adds it. */
  putProductionCut(id: string, cutId: string, body: ProductionCutBody): Promise<ProductionCutResource> {
    return this.request('PUT', `/api/v1/productions/${encodeURIComponent(id)}/cuts/${encodeURIComponent(cutId)}`, body);
  }

  deleteProductionCut(id: string, cutId: string): Promise<void> {
    return this.request('DELETE', `/api/v1/productions/${encodeURIComponent(id)}/cuts/${encodeURIComponent(cutId)}`);
  }

  /** Your characters, by name. */
  characters(): Promise<{ characters: CharacterSummary[] }> {
    return this.request('GET', '/api/v1/characters');
  }

  /** Stores one version of a character (`201`), or confirms the same one is stored (`200`); another with the same version is `409 version_exists`. */
  putCharacterVersion(slug: string, version: number, body: CharacterVersionBody): Promise<CharacterVersionResource> {
    return this.request('PUT', `/api/v1/characters/${encodeURIComponent(slug)}/versions/${version}`, body);
  }

  /** Which of these SHA-256 hashes you already have as production media, by hash. Asks 100 at a time. */
  async findProductionMedia(hashes: readonly string[]): Promise<Map<string, ProductionAsset>> {
    const unique = [...new Set(hashes)];
    const found = new Map<string, ProductionAsset>();
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const result = await this.request<{ found: Record<string, ProductionAsset> }>('GET', `/api/v1/productions/media?sha256=${batch.join(',')}`);
      for (const [sha, asset] of Object.entries(result.found)) found.set(sha, asset);
    }
    return found;
  }

  /** Uploads one production file, named by its hash. The studio streams it to storage and checks the hash. */
  async uploadProductionMedia(upload: ProductionMediaUpload): Promise<ProductionAsset> {
    const params = new URLSearchParams({ mediaType: upload.mediaType });
    if (upload.durationMs !== undefined) params.set('durationMs', String(Math.round(upload.durationMs)));
    if (upload.width !== undefined) params.set('width', String(upload.width));
    if (upload.height !== undefined) params.set('height', String(upload.height));
    const response = await this.send('PUT', `/api/v1/productions/media/${upload.sha256}?${params}`, {
      body: upload.body,
      // A Blob body carries its own Content-Length.
      headers: { 'Content-Type': upload.mimeType },
    });
    return await response.json() as ProductionAsset;
  }

  // --- Comments: review threads on a production's cuts (`comments:read`, `comments:write`).

  private threadPath(productionId: string, threadId?: string): string {
    const base = `/api/v1/productions/${encodeURIComponent(productionId)}/threads`;
    return threadId === undefined ? base : `${base}/${encodeURIComponent(threadId)}`;
  }

  /** The production's threads (or one cut's), in timeline order; `needsAgent` lists only those an agent should pick up. */
  async threads(productionId: string, filter: { cutId?: string; needsAgent?: boolean } = {}): Promise<ThreadResource[]> {
    const query = new URLSearchParams();
    if (filter.cutId) query.set('cutId', filter.cutId);
    if (filter.needsAgent) query.set('needsAgent', '1');
    const suffix = [...query.keys()].length ? `?${query}` : '';
    return (await this.request<{ threads: ThreadResource[] }>('GET', `${this.threadPath(productionId)}${suffix}`)).threads;
  }

  thread(productionId: string, threadId: string): Promise<ThreadDetail> {
    return this.request('GET', this.threadPath(productionId, threadId));
  }

  /** Everything an agent needs to act on the thread, in one answer. */
  threadContext(productionId: string, threadId: string): Promise<ContextBundle> {
    return this.request('GET', `${this.threadPath(productionId, threadId)}/context`);
  }

  createThread(productionId: string, body: { cutId: string; time: number; text: string; agent?: string }): Promise<ThreadResource> {
    return this.request('POST', this.threadPath(productionId), body);
  }

  setThreadStatus(productionId: string, threadId: string, status: ThreadStatus): Promise<ThreadResource> {
    return this.request('PATCH', this.threadPath(productionId, threadId), { status });
  }

  claimThread(productionId: string, threadId: string, body: { agent: string; minutes?: number }): Promise<ThreadResource> {
    return this.request('POST', `${this.threadPath(productionId, threadId)}/claim`, body);
  }

  releaseThread(productionId: string, threadId: string): Promise<ThreadResource> {
    return this.request('DELETE', `${this.threadPath(productionId, threadId)}/claim`);
  }

  postMessage(productionId: string, threadId: string, body: MessageBody): Promise<Message> {
    return this.request('POST', `${this.threadPath(productionId, threadId)}/messages`, body);
  }

  postSuggestions(productionId: string, threadId: string, body: SuggestionsBody): Promise<{ message: Message; suggestions: Suggestion[] }> {
    return this.request('POST', `${this.threadPath(productionId, threadId)}/suggestions`, body);
  }

  setSuggestionState(productionId: string, threadId: string, suggestionId: string, body: { state: SuggestionState; appliedAs?: string; agent?: string }): Promise<Suggestion> {
    return this.request('PATCH', `${this.threadPath(productionId, threadId)}/suggestions/${encodeURIComponent(suggestionId)}`, body);
  }

  decisions(productionId: string): Promise<{ decisions: Decision[]; constraints: Decision[] }> {
    return this.request('GET', `/api/v1/productions/${encodeURIComponent(productionId)}/decisions`);
  }

  addDecision(productionId: string, body: DecisionBody): Promise<Decision> {
    return this.request('POST', `/api/v1/productions/${encodeURIComponent(productionId)}/decisions`, body);
  }

  /** Says this agent is watching for comments, on one production or all of them. */
  commentHeartbeat(body: { agent: string; productionId?: string }): Promise<AgentHeartbeat> {
    return this.request('POST', '/api/v1/comments/heartbeat', body);
  }

  async listTrees(): Promise<TreeSummary[]> {
    const res = await this.request<{ trees: TreeSummary[] }>('GET', '/api/v1/trees');
    return res.trees;
  }

  async getTree(idOrTitle: string): Promise<TreeDetail> {
    const res = await this.request<{ tree: TreeDetail }>('GET', `/api/v1/trees/${encodeURIComponent(idOrTitle)}`);
    return res.tree;
  }

  async createTree(input: {
    title: string;
    description?: string;
    ops?: TreeOp[];
    idempotencyKey?: string;
  }): Promise<TreeDetail> {
    const { idempotencyKey, ...body } = input;
    const headers: Record<string, string> = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const res = await this.request<{ tree: TreeDetail }>('POST', '/api/v1/trees', body, true, headers);
    return res.tree;
  }

  async updateTree(id: string, patch: { title?: string; description?: string }): Promise<TreeDetail> {
    const res = await this.request<{ tree: TreeDetail }>('PATCH', `/api/v1/trees/${encodeURIComponent(id)}`, patch);
    return res.tree;
  }

  deleteTree(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.request<{ deleted: boolean; id: string }>('DELETE', `/api/v1/trees/${encodeURIComponent(id)}`);
  }

  async applyTreeOps(
    id: string,
    ops: TreeOp[],
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<TreeDetail> {
    const headers: Record<string, string> = options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {};
    const body: { ops: TreeOp[]; expectedRevision?: number } = {
      ops,
      ...(options?.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
    };
    const res = await this.request<{ tree: TreeDetail }>(
      'POST',
      `/api/v1/trees/${encodeURIComponent(id)}/ops`,
      body,
      true,
      headers,
    );
    return res.tree;
  }

  async getTreeDocument(treeId: string, nodeIdOrPath: string): Promise<TreeDocument> {
    const res = await this.request<{ document: TreeDocument }>(
      'GET',
      `/api/v1/trees/${encodeURIComponent(treeId)}/nodes/${encodeURIComponent(nodeIdOrPath)}`,
    );
    return res.document;
  }

  async compileTreeSelection(treeId: string, request: TreeCompileRequest): Promise<TreeCompileResult> {
    const res = await this.request<{ result: TreeCompileResult }>(
      'POST',
      `/api/v1/trees/${encodeURIComponent(treeId)}/compile`,
      request,
    );
    return res.result;
  }

  narration(id: string): Promise<NarrationResource> {
    return this.request('GET', `/api/v1/narrations/${encodeURIComponent(id)}`);
  }

  async audio(id: string): Promise<Uint8Array> {
    const response = await this.send('GET', `/api/v1/narrations/${encodeURIComponent(id)}/audio`, { headers: { Accept: '*/*' } });
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

  async createImageGeneration(
    itemId: string,
    body: ImageRequestBody,
    idempotencyKey: string = randomUUID(),
    retryDelaysMs: readonly number[] = [1000, 4000],
  ): Promise<CreatedMedia<'image'>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<CreatedMedia<'image'>>(
          'POST',
          `/api/v1/images/${encodeURIComponent(itemId)}/generations`,
          body,
          true,
          { 'Idempotency-Key': idempotencyKey },
        );
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined || !lostAnswer(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
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
