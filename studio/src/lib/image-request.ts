import type { ImageRequest } from './media-types';

export const IMAGE_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;
export const MAX_IMAGE_PROMPT = 32_000;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_IMAGE_REQUEST: ImageRequest = {
  prompt: '', adaptation: { enabled: false, instructions: '' },
  output: { aspectRatio: '16:9', resolution: null }, referenceAssetId: null,
};
export class MediaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const validMediaId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, 'invalid_body', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
function fields(raw: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) throw new MediaError(400, 'unknown_fields', `Unknown fields: ${unknown.join(', ')}.`);
}
export function parseImageRequest(body: unknown, defaults = DEFAULT_IMAGE_REQUEST): ImageRequest {
  const raw = object(body);
  fields(raw, ['prompt', 'adaptation', 'output', 'referenceAssetId']);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new MediaError(400, 'missing_prompt', 'Enter a prompt or paste your Markdown.');
  if (raw.prompt.length > MAX_IMAGE_PROMPT) throw new MediaError(400, 'prompt_too_long', `Image prompts are limited to ${MAX_IMAGE_PROMPT} characters.`);
  const adaptation = raw.adaptation === undefined ? defaults.adaptation : object(raw.adaptation);
  fields(adaptation, ['enabled', 'instructions']);
  const enabled = adaptation.enabled ?? defaults.adaptation.enabled;
  const instructions = adaptation.instructions ?? defaults.adaptation.instructions;
  if (typeof enabled !== 'boolean' || typeof instructions !== 'string' || instructions.length > 4000) throw new MediaError(400, 'invalid_adaptation', 'Adaptation needs an enabled flag and instructions of at most 4,000 characters.');
  const output = raw.output === undefined ? defaults.output : object(raw.output);
  fields(output, ['aspectRatio', 'resolution']);
  const aspectRatio = output.aspectRatio ?? defaults.output.aspectRatio;
  const resolution = output.resolution === undefined ? defaults.output.resolution : output.resolution;
  if (!IMAGE_RATIOS.includes(aspectRatio as typeof IMAGE_RATIOS[number])) throw new MediaError(400, 'invalid_aspect_ratio', 'Choose a supported image shape.');
  if (resolution !== null && !IMAGE_RESOLUTIONS.includes(resolution as typeof IMAGE_RESOLUTIONS[number])) throw new MediaError(400, 'invalid_resolution', 'Resolution must be 1K, 2K, 4K, or null for the model default.');
  const referenceAssetId = raw.referenceAssetId === undefined ? defaults.referenceAssetId : raw.referenceAssetId;
  if (referenceAssetId !== null && (typeof referenceAssetId !== 'string' || !validMediaId(referenceAssetId))) throw new MediaError(400, 'invalid_reference', 'Choose an uploaded reference image.');
  return { prompt: raw.prompt, adaptation: { enabled, instructions }, output: { aspectRatio: aspectRatio as string, resolution: resolution as string | null }, referenceAssetId: referenceAssetId as string | null };
}
export function readImageDefaults(value: unknown): ImageRequest {
  try { return { ...parseImageRequest({ ...object(value), prompt: 'defaults' }), prompt: '', referenceAssetId: null }; }
  catch { return structuredClone(DEFAULT_IMAGE_REQUEST); }
}
export function readIdempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{10,128}$/.test(key)) throw new MediaError(400, 'invalid_idempotency_key', 'Send an Idempotency-Key header containing 10–128 letters, numbers, underscores, or hyphens.');
  return key;
}
