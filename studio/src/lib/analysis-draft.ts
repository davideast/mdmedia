/**
 * The analysis composer's draft, the request body it sends, and the timestamps
 * an answer can seek to. Pure and browser-safe: no engine or Firebase imports.
 */
import type { AnalysisSource } from './media-types';
import type { VoiceChoice } from './types';

export const ANALYSIS_RESOLUTIONS = ['low', 'medium', 'high', 'ultra_high'] as const;
export const MAX_ANALYSIS_UPLOAD_BYTES = 200 * 1024 * 1024;
export const ANALYSIS_UPLOAD_ACCEPT = 'video/mp4,video/mpeg,video/quicktime,video/x-msvideo,video/x-flv,video/webm,video/x-ms-wmv,video/3gpp,.mp4,.m4v,.mpeg,.mpg,.mov,.avi,.flv,.webm,.wmv,.3gp';

export interface AnalysisDraft {
  kind: 'analysis';
  prompt: string;
  source: AnalysisSource | null;
  /** What the source control shows: a file name, a video title, or the link. */
  sourceLabel: string;
  /** Empty uses the Studio default. */
  model: string;
  /** Agentic processing: the model moves through the video itself. */
  longVideo: boolean;
  /** Clip range and frame rate as typed (`1:30`, `90`, `0.5`); static only. */
  start: string;
  end: string;
  fps: string;
  mediaResolution: '' | (typeof ANALYSIS_RESOLUTIONS)[number];
  systemInstruction: string;
  narrate: boolean;
  /** Null narrates with the Studio default voice. */
  voice: VoiceChoice | null;
}

export const DEFAULT_ANALYSIS_DRAFT: AnalysisDraft = {
  kind: 'analysis', prompt: '', source: null, sourceLabel: '', model: '', longVideo: false,
  start: '', end: '', fps: '', mediaResolution: '', systemInstruction: '', narrate: false, voice: null,
};

export interface AnalysisBody {
  prompt: string;
  source?: { kind: 'video'; videoItemId: string; generationId?: string; clip?: number } | { kind: 'asset'; assetId: string } | { kind: 'youtube'; url: string };
  model?: string;
  processing?: { mode: 'static' | 'agentic'; startSeconds?: number; endSeconds?: number; fps?: number };
  mediaResolution?: AnalysisDraft['mediaResolution'];
  systemInstruction?: string;
  narrate?: true | { voice: { provider: VoiceChoice['provider']; id: string } };
}

const string = (value: unknown) => typeof value === 'string' ? value : '';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function readSource(value: unknown): AnalysisSource | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'video' && typeof raw.videoItemId === 'string' && ID.test(raw.videoItemId)) {
    return { kind: 'video', videoItemId: raw.videoItemId, generationId: typeof raw.generationId === 'string' && ID.test(raw.generationId) ? raw.generationId : null,
      clip: typeof raw.clip === 'number' && Number.isInteger(raw.clip) && raw.clip > 0 ? raw.clip : null };
  }
  if (raw.kind === 'asset' && typeof raw.assetId === 'string' && ID.test(raw.assetId)) return { kind: 'asset', assetId: raw.assetId };
  if (raw.kind === 'youtube' && typeof raw.url === 'string') return { kind: 'youtube', url: raw.url.slice(0, 2048) };
  return null;
}

/** A saved draft, with anything malformed replaced by its default. */
export function readAnalysisDraft(value: unknown): AnalysisDraft | null {
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'analysis') return null;
  const raw = value as Record<string, unknown>;
  const voice = raw.voice && typeof raw.voice === 'object' ? raw.voice as Record<string, unknown> : null;
  return {
    kind: 'analysis', prompt: string(raw.prompt), source: readSource(raw.source), sourceLabel: string(raw.sourceLabel).slice(0, 300),
    model: string(raw.model), longVideo: raw.longVideo === true, start: string(raw.start), end: string(raw.end), fps: string(raw.fps),
    mediaResolution: (ANALYSIS_RESOLUTIONS as readonly unknown[]).includes(raw.mediaResolution) ? raw.mediaResolution as AnalysisDraft['mediaResolution'] : '',
    systemInstruction: string(raw.systemInstruction), narrate: raw.narrate === true,
    voice: voice && (voice.provider === 'gemini' || voice.provider === 'elevenlabs') && typeof voice.id === 'string' && typeof voice.name === 'string'
      ? { provider: voice.provider, id: voice.id, name: voice.name } : null,
  };
}

/** Seconds from `90`, `1:30`, or `1:02:03`; null for anything else. */
export function parseTimestamp(text: string): number | null {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const clock = /^(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!clock || (clock[1] !== undefined && Number(clock[2]) > 59)) return null;
  return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
}

/** A time typed in options: empty, or seconds. Throws a short message naming the field. */
function optionalTime(label: string, value: string): number | undefined {
  if (!value.trim()) return undefined;
  const seconds = parseTimestamp(value);
  if (seconds === null) throw new Error(`${label} must be a time like 1:30.`);
  return seconds;
}

/**
 * The create body for a draft. Only what was set is sent, so Studio defaults
 * fill the rest. Long video mode drops the clip range and frame rate, which
 * apply only to the default mode.
 */
export function analysisBody(draft: AnalysisDraft): AnalysisBody {
  const body: AnalysisBody = { prompt: draft.prompt };
  const source = draft.source;
  if (source?.kind === 'video') body.source = { kind: 'video', videoItemId: source.videoItemId, ...(source.generationId ? { generationId: source.generationId } : {}), ...(source.clip ? { clip: source.clip } : {}) };
  else if (source) body.source = source;
  if (draft.model.trim()) body.model = draft.model.trim();
  if (draft.longVideo) body.processing = { mode: 'agentic' };
  else {
    const startSeconds = optionalTime('Start', draft.start); const endSeconds = optionalTime('End', draft.end);
    const fps = draft.fps.trim() ? Number(draft.fps) : undefined;
    if (fps !== undefined && (!Number.isFinite(fps) || fps <= 0)) throw new Error('Frame rate must be a number above 0.');
    if (startSeconds !== undefined && endSeconds !== undefined && endSeconds <= startSeconds) throw new Error('End must be after start.');
    if (startSeconds !== undefined || endSeconds !== undefined || fps !== undefined) {
      body.processing = { mode: 'static', ...(startSeconds !== undefined ? { startSeconds } : {}), ...(endSeconds !== undefined ? { endSeconds } : {}), ...(fps !== undefined ? { fps } : {}) };
    }
  }
  if (draft.mediaResolution) body.mediaResolution = draft.mediaResolution;
  if (draft.systemInstruction.trim()) body.systemInstruction = draft.systemInstruction;
  if (draft.narrate) body.narrate = draft.voice ? { voice: { provider: draft.voice.provider, id: draft.voice.id } } : true;
  return body;
}

export type TimestampPart = string | { label: string; seconds: number };

// Not part of a longer number or ratio, e.g. `112:34` or `1:23:45:67`.
// A trailing colon is punctuation ("00:05: intro"); a colon and digit means a longer number.
const TIMESTAMP = /(?<![\d:.])(?:\d{1,2}:)?\d{1,2}:[0-5]\d(?!\d|:\d)/g;

/** Text split around `MM:SS` and `H:MM:SS` timestamps, which an answer can seek to. */
export function splitTimestamps(text: string): TimestampPart[] {
  const parts: TimestampPart[] = [];
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP)) {
    const seconds = parseTimestamp(match[0]);
    if (seconds === null) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ label: match[0], seconds });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export { normalizeAnalysisMarkdown } from './analysis-markdown';
