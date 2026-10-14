import { MediaError, validMediaId } from './image-request';
import type { VideoRequest } from './media-types';
export const VIDEO_RESOLUTIONS = ['360p', '720p', '1080p', '4k'] as const;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const DEFAULT_VIDEO_REQUEST: VideoRequest = {
  prompt: '', adaptation: { enabled: false, instructions: '' },
  output: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 10 }, referenceAssetId: null, referenceRole: 'reference',
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, 'invalid_body', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new MediaError(400, 'unknown_fields', 'Unknown video settings.');
}
export function parseVideoRequest(value: unknown, defaults = DEFAULT_VIDEO_REQUEST): VideoRequest {
  const raw = object(value); fields(raw, ['prompt', 'adaptation', 'output', 'referenceAssetId', 'referenceRole']);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 32000) throw new MediaError(400, 'invalid_prompt', 'Enter a prompt of 1–32,000 characters.');
  const adaptation = raw.adaptation === undefined ? defaults.adaptation : object(raw.adaptation); fields(adaptation, ['enabled', 'instructions']);
  const enabled = adaptation.enabled ?? defaults.adaptation.enabled; const instructions = adaptation.instructions ?? defaults.adaptation.instructions;
  if (typeof enabled !== 'boolean' || typeof instructions !== 'string' || instructions.length > 4000) throw new MediaError(400, 'invalid_adaptation', 'Use a toggle and instructions of at most 4,000 characters.');
  const output = raw.output === undefined ? defaults.output : object(raw.output); fields(output, ['aspectRatio', 'resolution', 'durationSeconds']);
  const aspectRatio = output.aspectRatio ?? defaults.output.aspectRatio; const resolution = output.resolution ?? defaults.output.resolution; const durationSeconds = output.durationSeconds ?? defaults.output.durationSeconds;
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') throw new MediaError(400, 'invalid_aspect_ratio', 'Choose landscape or portrait.');
  if (!VIDEO_RESOLUTIONS.includes(resolution as typeof VIDEO_RESOLUTIONS[number])) throw new MediaError(400, 'invalid_resolution', 'Choose a supported video resolution.');
  if (typeof durationSeconds !== 'number' || !Number.isInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > 10) throw new MediaError(400, 'invalid_duration', 'Clip length must be 3–10 whole seconds.');
  const referenceAssetId = raw.referenceAssetId === undefined ? defaults.referenceAssetId : raw.referenceAssetId;
  if (referenceAssetId !== null && (typeof referenceAssetId !== 'string' || !validMediaId(referenceAssetId))) throw new MediaError(400, 'invalid_reference', 'Choose an uploaded reference.');
  const referenceRole = raw.referenceRole ?? defaults.referenceRole;
  if (referenceRole !== 'first_frame' && referenceRole !== 'reference') throw new MediaError(400, 'invalid_reference_role', 'Choose first frame or reference.');
  return { prompt: raw.prompt, adaptation: { enabled, instructions }, output: { aspectRatio, resolution: resolution as VideoRequest['output']['resolution'], durationSeconds }, referenceAssetId: referenceAssetId as string | null, referenceRole };
}
export function readVideoDefaults(value: unknown): VideoRequest {
  try { return { ...parseVideoRequest({ ...object(value), prompt: 'defaults' }), prompt: '', referenceAssetId: null }; }
  catch { return structuredClone(DEFAULT_VIDEO_REQUEST); }
}
export function videoActionBody(body: Record<string, unknown>): { action: 'continue' | 'regenerate_latest'; fromGenerationId: string; settings: Record<string, unknown> } {
  const { action, fromGenerationId, ...settings } = body;
  if (action !== 'continue' && action !== 'regenerate_latest') throw new MediaError(400, 'invalid_action', 'Choose continue or regenerate_latest.');
  if (typeof fromGenerationId !== 'string' || !validMediaId(fromGenerationId)) throw new MediaError(400, 'missing_generation', 'Send the current fromGenerationId.');
  return { action, fromGenerationId, settings };
}
