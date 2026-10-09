/**
 * The `/api/v1/narrations` request contract.
 *
 * Every field except `markdown` is optional; anything left out takes the
 * caller's own Settings, so `{ "markdown": "…" }` narrates exactly as the
 * composer would by default. Pure, so it is tested without a server.
 */

import { parseNarrationRequest, type NarrationRequest } from './narration-request';
import {
  DELIVERY_PRESETS,
  INSTRUCTION_PRESETS,
  isElevenLabsVoiceId,
  type Narration,
  MAX_PRESET_TEXT,
  settingsDefaultVoice,
  TTS_MODELS,
  VOICES,
  type TextPreset,
  type UserSettings,
  type Visibility,
  type VoiceChoice,
} from './types';

export const MAX_MARKDOWN_CHARS = 200_000;

export interface NarrationApiBody {
  markdown: string;
  /** Optional client-chosen id (10–128 of A–Z a–z 0–9 _ -). Reusing your own id is how a retry avoids a duplicate. */
  id?: string;
  /** A Gemini voice name, an ElevenLabs voice id, or `{ provider, id }`. */
  voice?: string | { provider: 'gemini' | 'elevenlabs'; id: string };
  model?: string;
  /** Delivery text, or `deliveryPreset` to use a saved or built-in preset by name or id. */
  delivery?: string;
  deliveryPreset?: string;
  speed?: number;
  rewriteForNarration?: boolean;
  /** Rewrite instructions, or `instructionsPreset` by name or id. */
  instructions?: string;
  instructionsPreset?: string;
  structureMarkdown?: boolean;
  verbalizeDiagrams?: boolean;
  visibility?: Visibility;
}

const FIELDS = new Set<string>([
  'markdown', 'id', 'voice', 'model', 'delivery', 'deliveryPreset', 'speed', 'rewriteForNarration',
  'instructions', 'instructionsPreset', 'structureMarkdown', 'verbalizeDiagrams', 'visibility',
]);

export type ResolveResult =
  | { ok: true; request: NarrationRequest }
  | { ok: false; status: 400 | 403; code: string; message: string };

const invalid = (code: string, message: string): ResolveResult => ({ ok: false, status: 400, code, message });

export function findPreset(presets: readonly TextPreset[], nameOrId: string): TextPreset | undefined {
  const wanted = nameOrId.trim().toLowerCase();
  return presets.find((preset) => preset.id.toLowerCase() === wanted) ??
    presets.find((preset) => preset.name.toLowerCase() === wanted);
}

function resolveVoice(value: unknown, settings: UserSettings): VoiceChoice | string {
  if (value === undefined) return settingsDefaultVoice(settings);
  if (typeof value === 'string') {
    const gemini = VOICES.find((name) => name.toLowerCase() === value.trim().toLowerCase());
    if (gemini) return { provider: 'gemini', id: gemini, name: gemini };
    if (isElevenLabsVoiceId(value)) return { provider: 'elevenlabs', id: value, name: 'ElevenLabs voice' };
    return `Unknown voice "${value}". Use a Gemini voice name (${VOICES.slice(0, 4).join(', ')}, …) or an ElevenLabs voice id. GET /api/v1/options lists them.`;
  }
  if (typeof value === 'object' && value !== null) {
    const { provider, id } = value as { provider?: unknown; id?: unknown };
    if (provider === 'gemini' && typeof id === 'string') return resolveVoice(id, settings);
    if (provider === 'elevenlabs' && isElevenLabsVoiceId(id)) return { provider, id, name: 'ElevenLabs voice' };
  }
  return 'voice must be a Gemini voice name, an ElevenLabs voice id, or { "provider": "gemini" | "elevenlabs", "id": "…" }.';
}

function resolveText(
  label: string, text: unknown, presetName: unknown, presets: readonly TextPreset[], fallback: string,
): string | { error: ResolveResult } {
  if (text !== undefined && presetName !== undefined) {
    return { error: invalid('conflicting_fields', `Pass either ${label} or ${label}Preset, not both.`) };
  }
  if (presetName !== undefined) {
    const preset = typeof presetName === 'string' ? findPreset(presets, presetName) : undefined;
    if (!preset) {
      return { error: invalid('unknown_preset', `No ${label} preset named "${String(presetName)}". Available: ${presets.map((item) => item.name).join(', ')}.`) };
    }
    return preset.text;
  }
  if (text === undefined) return fallback;
  if (typeof text !== 'string' || text.length > MAX_PRESET_TEXT) {
    return { error: invalid('invalid_field', `${label} must be text of at most ${MAX_PRESET_TEXT} characters.`) };
  }
  return text;
}

/**
 * Validates a v1 body and fills it from the caller's settings. `restricted`
 * callers (API keys) may only create private narrations.
 */
export function resolveNarrationBody(body: unknown, settings: UserSettings, { restricted }: { restricted: boolean }): ResolveResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('invalid_body', 'Send a JSON object with at least "markdown".');
  }
  const raw = body as Record<string, unknown>;
  const unknownFields = Object.keys(raw).filter((key) => !FIELDS.has(key));
  if (unknownFields.length > 0) {
    return invalid('unknown_fields', `Unknown field${unknownFields.length > 1 ? 's' : ''}: ${unknownFields.join(', ')}.`);
  }
  if (typeof raw.markdown !== 'string' || raw.markdown.trim().length === 0) {
    return invalid('missing_markdown', '"markdown" is required and must contain text.');
  }
  if (raw.markdown.length > MAX_MARKDOWN_CHARS) {
    return invalid('markdown_too_long', `"markdown" is limited to ${MAX_MARKDOWN_CHARS.toLocaleString('en-US')} characters.`);
  }

  const voice = resolveVoice(raw.voice, settings);
  if (typeof voice === 'string') return invalid('invalid_voice', voice);

  if (raw.model !== undefined && !(TTS_MODELS as readonly unknown[]).includes(raw.model)) {
    return invalid('invalid_model', `model must be one of: ${TTS_MODELS.join(', ')}.`);
  }
  if (raw.speed !== undefined && (typeof raw.speed !== 'number' || !Number.isFinite(raw.speed) || raw.speed < 0.5 || raw.speed > 2.5)) {
    return invalid('invalid_speed', 'speed must be a number from 0.5 to 2.5.');
  }
  for (const flag of ['rewriteForNarration', 'structureMarkdown', 'verbalizeDiagrams'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return invalid('invalid_field', `${flag} must be true or false.`);
  }
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(raw.id))) {
    return invalid('invalid_id', 'id must be 10–128 characters of A–Z, a–z, 0–9, _ or -.');
  }

  const visibility = raw.visibility ?? settings.defaultVisibility;
  if (visibility !== 'private' && visibility !== 'shared' && visibility !== 'public') {
    return invalid('invalid_visibility', 'visibility must be private, shared, or public.');
  }
  // A key is a credential an agent holds. It may make narrations for you, but
  // not publish them: sharing stays a decision made in the studio.
  const effectiveVisibility: Visibility = restricted && raw.visibility === undefined ? 'private' : visibility;
  if (restricted && effectiveVisibility !== 'private') {
    return { ok: false, status: 403, code: 'visibility_not_allowed', message: 'API keys create private narrations. Share it from the studio afterwards.' };
  }

  const delivery = resolveText('delivery', raw.delivery, raw.deliveryPreset,
    [...DELIVERY_PRESETS, ...settings.deliveryPresets], settings.defaultPromptStyle);
  if (typeof delivery !== 'string') return delivery.error;
  const instructions = resolveText('instructions', raw.instructions, raw.instructionsPreset,
    [...INSTRUCTION_PRESETS, ...settings.instructionPresets], settings.defaultRewriteInstructions);
  if (typeof instructions !== 'string') return instructions.error;

  const request = parseNarrationRequest({
    id: raw.id,
    markdown: raw.markdown,
    voice: voice.name,
    voiceProvider: voice.provider,
    voiceId: voice.id,
    model: raw.model ?? settings.defaultGeminiModel,
    promptStyle: delivery,
    speed: raw.speed,
    rewriteForNarration: raw.rewriteForNarration ?? settings.rewriteForNarration,
    rewriteInstructions: instructions,
    structureMarkdown: raw.structureMarkdown ?? settings.structureMarkdown,
    verbalizeDiagrams: raw.verbalizeDiagrams ?? settings.verbalizeDiagrams,
    visibility: effectiveVisibility,
  });
  if (!request) return invalid('invalid_body', 'That narration request is not valid.');
  return { ok: true, request };
}

/** A narration as `/api/v1` reports it: status, outcome, and where to listen. */
export function toNarrationResource(narration: Narration, origin: string) {
  return {
    id: narration.id,
    title: narration.title,
    status: narration.status,
    visibility: narration.visibility,
    voice: { provider: narration.voiceProvider ?? 'gemini', name: narration.voice },
    model: narration.model ?? null,
    adapted: narration.adapted,
    durationMs: narration.durationMs,
    createdAt: narration.createdAt,
    updatedAt: narration.updatedAt,
    error: narration.status === 'error'
      ? { code: narration.errorCode ?? 'failed', message: narration.errorMessage ?? 'Narration failed.', hint: narration.errorActionableHint ?? null }
      : null,
    links: {
      web: `${origin}/narration/${narration.id}`,
      self: `${origin}/api/v1/narrations/${narration.id}`,
      audio: narration.status === 'ready' ? `${origin}/api/v1/narrations/${narration.id}/audio` : null,
    },
  };
}
