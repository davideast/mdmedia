import { MEDIA_RESOLUTIONS, validateAnalysis, type VideoSource } from 'mdmedia/analysis';
import { MediaError, validMediaId } from './image-request';
import { resolveNarrationBody, type NarrationPlacement } from './narration-api';
import type { NarrationRequest } from './narration-request';
import type { AnalysisRequest, AnalysisSource } from './media-types';
import type { UserSettings } from './types';

export const MAX_ANALYSIS_PROMPT = 32_000;
export const MAX_SYSTEM_INSTRUCTION = 8_000;
/** Characters of JSON. Plenty for a real schema; keeps stored requests small. */
export const MAX_RESPONSE_SCHEMA = 32_000;
const FIELDS = ['prompt', 'source', 'model', 'processing', 'mediaResolution', 'systemInstruction', 'responseSchema', 'narrate', 'previousInteractionId'];
const INTERACTION_ID = /^[A-Za-z0-9_\-/.]{1,256}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/;

/** The narration options an analysis carries until its result exists: everything but the text and id. */
export interface AnalysisNarration {
  request: Omit<NarrationRequest, 'markdown' | 'id'>;
  placement: NarrationPlacement | null;
}

function object(value: unknown, code = 'invalid_body', message = 'Send a JSON object.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, code, message);
  return value as Record<string, unknown>;
}
function fields(raw: Record<string, unknown>, allowed: string[], what: string) {
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) throw new MediaError(400, 'unknown_fields', `Unknown ${what}: ${unknown.join(', ')}.`);
}
const optionalNumber = (value: unknown, label: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MediaError(400, 'invalid_processing', `${label} must be a number.`);
  return value;
};

function parseSource(value: unknown): AnalysisSource {
  const raw = object(value, 'invalid_source', 'source must be { "kind": "video" | "asset" | "youtube", … }.');
  if (raw.kind === 'video') {
    fields(raw, ['kind', 'videoItemId', 'generationId', 'clip'], 'video source fields');
    if (typeof raw.videoItemId !== 'string' || !validMediaId(raw.videoItemId)) throw new MediaError(400, 'invalid_source', 'source.videoItemId must be a video id.');
    if (raw.generationId !== undefined && raw.generationId !== null && (typeof raw.generationId !== 'string' || !validMediaId(raw.generationId))) throw new MediaError(400, 'invalid_source', 'source.generationId must be a generation id.');
    if (raw.clip !== undefined && raw.clip !== null && (typeof raw.clip !== 'number' || !Number.isInteger(raw.clip) || raw.clip < 1)) throw new MediaError(400, 'invalid_source', 'source.clip must be a clip number from 1.');
    return { kind: 'video', videoItemId: raw.videoItemId, generationId: (raw.generationId as string | undefined) ?? null, clip: (raw.clip as number | undefined) ?? null };
  }
  if (raw.kind === 'asset') {
    fields(raw, ['kind', 'assetId'], 'asset source fields');
    if (typeof raw.assetId !== 'string' || !validMediaId(raw.assetId)) throw new MediaError(400, 'invalid_source', 'source.assetId must be an uploaded video id.');
    return { kind: 'asset', assetId: raw.assetId };
  }
  if (raw.kind === 'youtube') {
    fields(raw, ['kind', 'url'], 'YouTube source fields');
    if (typeof raw.url !== 'string' || raw.url.length > 2048) throw new MediaError(400, 'invalid_source', 'source.url must be a YouTube link.');
    return { kind: 'youtube', url: raw.url.trim() };
  }
  throw new MediaError(400, 'invalid_source', 'source.kind must be video, asset, or youtube.');
}

function parseProcessing(value: unknown): AnalysisRequest['processing'] {
  if (value === null) return null;
  const raw = object(value, 'invalid_processing', 'processing must be { "mode": "static" | "agentic", … }.');
  fields(raw, ['mode', 'startSeconds', 'endSeconds', 'fps'], 'processing fields');
  const mode = raw.mode ?? 'static';
  if (mode !== 'static' && mode !== 'agentic') throw new MediaError(400, 'invalid_processing', 'processing.mode must be static or agentic.');
  return { mode, startSeconds: optionalNumber(raw.startSeconds, 'startSeconds'), endSeconds: optionalNumber(raw.endSeconds, 'endSeconds'), fps: optionalNumber(raw.fps, 'fps') };
}

/** Firestore cannot store an array directly inside an array. */
const nestedArray = (value: unknown, inArray = false): boolean => Array.isArray(value)
  ? inArray || value.some(entry => nestedArray(entry, true))
  : Boolean(value) && typeof value === 'object' && Object.values(value as object).some(entry => nestedArray(entry));

function parseResponseSchema(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const invalid = (message: string) => new MediaError(400, 'invalid_response_schema', message);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('responseSchema must be a JSON Schema object.');
  if (JSON.stringify(value).length > MAX_RESPONSE_SCHEMA) throw invalid(`responseSchema is limited to ${MAX_RESPONSE_SCHEMA.toLocaleString('en-US')} characters of JSON.`);
  if (nestedArray(value)) throw invalid('responseSchema cannot hold an array directly inside another array.');
  return value as Record<string, unknown>;
}

/**
 * Parses a create or re-run body. Omitted fields keep `defaults` (the item's last request), so a
 * re-run sends only what changes. `model` resolves the model the engine's checks run against, so
 * a bad combination (agentic on a static-only model, a clip range with agentic) fails here with
 * 400 instead of in the worker after acceptance.
 */
export function parseAnalysisRequest(body: unknown, options: { defaults: AnalysisRequest | null; model: string; followUps: boolean }): { request: AnalysisRequest; narrate: unknown } {
  const raw = object(body); fields(raw, FIELDS, 'analysis fields');
  const { defaults } = options;
  const followUp = raw.previousInteractionId;
  if (followUp !== undefined && followUp !== null) {
    if (!options.followUps) throw new MediaError(400, 'follow_up_needs_item', 'Ask a follow-up on an existing analysis: POST /api/v1/analyses/{id}/generations.');
    if (typeof followUp !== 'string' || !INTERACTION_ID.test(followUp)) throw new MediaError(400, 'invalid_follow_up', 'previousInteractionId must be an interaction id from this analysis.');
    for (const key of ['source', 'processing', 'mediaResolution']) {
      if (raw[key] !== undefined) throw new MediaError(400, 'invalid_follow_up', `A follow-up reuses the earlier video; leave out ${key}.`);
    }
  }
  const prompt = raw.prompt === undefined ? defaults?.prompt : raw.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_ANALYSIS_PROMPT) throw new MediaError(400, 'invalid_prompt', 'Enter a prompt of 1–32,000 characters.');
  const source = raw.source === undefined ? defaults?.source : parseSource(raw.source);
  if (!source) throw new MediaError(400, 'missing_source', 'Choose a source: a Studio video, an uploaded video, or a YouTube link.');
  const model = raw.model === undefined ? defaults?.model ?? null : raw.model;
  if (model !== null && (typeof model !== 'string' || !MODEL_ID.test(model))) throw new MediaError(400, 'invalid_model', 'model must be a Gemini model id.');
  const processing = raw.processing === undefined ? defaults?.processing ?? null : parseProcessing(raw.processing);
  const mediaResolution = raw.mediaResolution === undefined ? defaults?.mediaResolution ?? null : raw.mediaResolution;
  if (mediaResolution !== null && !(MEDIA_RESOLUTIONS as readonly unknown[]).includes(mediaResolution)) throw new MediaError(400, 'invalid_media_resolution', `mediaResolution must be one of ${MEDIA_RESOLUTIONS.join(', ')}.`);
  const systemInstruction = raw.systemInstruction === undefined ? defaults?.systemInstruction ?? null : raw.systemInstruction;
  if (systemInstruction !== null && (typeof systemInstruction !== 'string' || !systemInstruction.trim() || systemInstruction.length > MAX_SYSTEM_INSTRUCTION)) throw new MediaError(400, 'invalid_system_instruction', 'systemInstruction must be text of 1–8,000 characters.');
  // Kept on re-runs and follow-ups like the other settings, so a JSON analysis keeps answering in JSON; null returns to Markdown.
  const responseSchema = raw.responseSchema === undefined ? defaults?.responseSchema ?? null : parseResponseSchema(raw.responseSchema);
  const request: AnalysisRequest = {
    prompt, source, model, processing, mediaResolution: mediaResolution as AnalysisRequest['mediaResolution'],
    systemInstruction, responseSchema, previousInteractionId: typeof followUp === 'string' ? followUp : null,
  };
  try { validateAnalysis(prompt, request.previousInteractionId ? [] : [validationSource(source)], model ?? options.model, providerOptions(request)); }
  catch (error) { throw new MediaError(400, 'invalid_analysis', error instanceof Error ? error.message : 'That analysis request is not valid.'); }
  return { request, narrate: raw.narrate };
}

/** Stored bytes are checked against the provider's MIME list when they are uploaded; here only the shape matters. */
function validationSource(source: AnalysisSource): VideoSource {
  return source.kind === 'youtube' ? { kind: 'youtube', url: source.url } : { kind: 'bytes', bytes: new Uint8Array(), mimeType: 'video/mp4' };
}

/** The engine options a stored request maps to. */
export function providerOptions(request: AnalysisRequest) {
  const processing = request.processing;
  return {
    ...(processing ? { processing: processing.mode } : {}),
    ...(processing?.startSeconds != null ? { startSeconds: processing.startSeconds } : {}),
    ...(processing?.endSeconds != null ? { endSeconds: processing.endSeconds } : {}),
    ...(processing?.fps != null ? { fps: processing.fps } : {}),
    ...(request.mediaResolution ? { mediaResolution: request.mediaResolution } : {}),
    ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
    ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
    ...(request.previousInteractionId ? { previousInteractionId: request.previousInteractionId } : {}),
  };
}

/**
 * `narrate` is a `POST /api/v1/narrations` body without `markdown` or `id`, or `true` for the
 * caller's Studio defaults. It goes through the narration validator itself, so defaults, presets,
 * unknown-field rejection and the API-key private-only rule match the narration API exactly.
 */
export function resolveAnalysisNarration(narrate: unknown, settings: UserSettings, restricted: boolean): AnalysisNarration | null {
  if (narrate === undefined || narrate === false) return null;
  const overrides = narrate === true ? {} : object(narrate, 'invalid_narrate', 'narrate must be true or a narration options object.');
  for (const key of ['markdown', 'id']) {
    if (key in overrides) throw new MediaError(400, 'invalid_narrate', `narrate.${key} is set by Studio from the analysis result.`);
  }
  // A placeholder stands in for the result, which does not exist yet; its length is checked once it does.
  const resolved = resolveNarrationBody({ ...overrides, markdown: 'Analysis result.' }, settings, { restricted });
  if (!resolved.ok) throw new MediaError(resolved.status, resolved.code, `narrate: ${resolved.message}`);
  const { markdown: _markdown, id: _id, ...request } = resolved.request;
  return { request, placement: resolved.placement };
}
