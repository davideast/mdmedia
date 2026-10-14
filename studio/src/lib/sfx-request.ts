import { MediaError } from './image-request';
import type { SfxRequest } from './media-types';
export const MAX_SFX_PROMPT = 4000;
export const MAX_SFX_BYTES = 20 * 1024 * 1024;
export const SFX_DURATION = { min: 0.5, max: 30 } as const;
export const DEFAULT_SFX_REQUEST: SfxRequest = { prompt: '', output: { format: 'mp3', durationSeconds: null, loop: false }, promptInfluence: 0.3 };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, 'invalid_body', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
function fields(raw: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new MediaError(400, 'unknown_fields', 'Unknown sound effect settings.');
}
/** Omitted fields keep `defaults`, so a new attempt may send only what changes. */
export function parseSfxRequest(body: unknown, defaults = DEFAULT_SFX_REQUEST): SfxRequest {
  const raw = object(body); fields(raw, ['prompt', 'output', 'promptInfluence']);
  const prompt = raw.prompt === undefined ? defaults.prompt : raw.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_SFX_PROMPT) throw new MediaError(400, 'invalid_prompt', 'Enter a prompt of 1–4,000 characters.');
  const output = raw.output === undefined ? {} : object(raw.output); fields(output, ['format', 'durationSeconds', 'loop']);
  const format = output.format === undefined ? defaults.output.format : output.format;
  if (format !== 'mp3' && format !== 'wav') throw new MediaError(400, 'invalid_format', 'Choose MP3 or WAV.');
  const durationSeconds = output.durationSeconds === undefined ? defaults.output.durationSeconds : output.durationSeconds;
  if (durationSeconds !== null && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < SFX_DURATION.min || durationSeconds > SFX_DURATION.max)) throw new MediaError(400, 'invalid_duration', 'Choose a length of 0.5–30 seconds, or null to let the model choose.');
  const loop = output.loop === undefined ? defaults.output.loop : output.loop;
  if (typeof loop !== 'boolean') throw new MediaError(400, 'invalid_loop', 'Loop must be true or false.');
  const promptInfluence = raw.promptInfluence === undefined ? defaults.promptInfluence : raw.promptInfluence;
  if (typeof promptInfluence !== 'number' || !Number.isFinite(promptInfluence) || promptInfluence < 0 || promptInfluence > 1) throw new MediaError(400, 'invalid_influence', 'Prompt influence must be between 0 and 1.');
  return { prompt, output: { format, durationSeconds, loop }, promptInfluence };
}
export function readSfxDefaults(value: unknown): SfxRequest {
  try { return { ...parseSfxRequest({ ...object(value), prompt: 'defaults' }), prompt: '' }; }
  catch { return structuredClone(DEFAULT_SFX_REQUEST); }
}
