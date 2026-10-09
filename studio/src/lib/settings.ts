/**
 * Normalizes the `settings` map stored on `users/{uid}`. Pure, so the browser
 * and the server read preferences through one migration path.
 */

import { migrateDeliveryPresets, readSavedPresets } from './presets';
import {
  DEFAULT_SETTINGS,
  DELIVERY_PRESETS,
  HIGHLIGHT_COLORS,
  isVoiceRef,
  readDefaultVoiceRef,
  TTS_MODELS,
  type HighlightColorId,
  type UserSettings,
} from './types';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function readSettings(value: unknown): UserSettings {
  const raw = (value ?? {}) as Partial<UserSettings>;
  const defaultVoiceRef = readDefaultVoiceRef(raw);
  const pinnedVoiceRefs = Array.isArray(raw.pinnedVoiceRefs)
    ? raw.pinnedVoiceRefs.filter(isVoiceRef).filter((ref, index, refs) =>
      refs.findIndex((other) => other.provider === ref.provider && other.id === ref.id) === index).slice(0, 20)
    : [];
  const preferredGeminiModel = raw.defaultGeminiModel;
  const validHighlight = HIGHLIGHT_COLORS.some((c) => c.id === raw.highlightColor)
    ? (raw.highlightColor as HighlightColorId)
    : DEFAULT_SETTINGS.highlightColor;
  return {
    defaultVoice: defaultVoiceRef.provider === 'gemini'
      ? defaultVoiceRef.id : asString(raw.defaultVoice, defaultVoiceRef.id),
    defaultVoiceRef,
    defaultVoiceProvider: defaultVoiceRef.provider,
    defaultVoiceId: defaultVoiceRef.id,
    pinnedVoiceRefs,
    defaultGeminiModel: preferredGeminiModel && TTS_MODELS.includes(preferredGeminiModel)
      ? preferredGeminiModel
      : DEFAULT_SETTINGS.defaultGeminiModel,
    defaultPromptStyle: asString(raw.defaultPromptStyle, DEFAULT_SETTINGS.defaultPromptStyle),
    rewriteForNarration:
      typeof raw.rewriteForNarration === 'boolean'
        ? raw.rewriteForNarration
        : DEFAULT_SETTINGS.rewriteForNarration,
    autoPlay: typeof raw.autoPlay === 'boolean' ? raw.autoPlay : DEFAULT_SETTINGS.autoPlay,
    defaultVisibility: raw.defaultVisibility ?? DEFAULT_SETTINGS.defaultVisibility,
    highlightColor: validHighlight,
    deliveryPresets: migrateDeliveryPresets(
      raw.deliveryPresets, asString(raw.defaultPromptStyle, DEFAULT_SETTINGS.defaultPromptStyle), DELIVERY_PRESETS),
    instructionPresets: readSavedPresets(raw.instructionPresets),
    defaultRewriteInstructions: asString(raw.defaultRewriteInstructions, DEFAULT_SETTINGS.defaultRewriteInstructions),
    structureMarkdown: typeof raw.structureMarkdown === 'boolean' ? raw.structureMarkdown : DEFAULT_SETTINGS.structureMarkdown,
    verbalizeDiagrams: typeof raw.verbalizeDiagrams === 'boolean' ? raw.verbalizeDiagrams : DEFAULT_SETTINGS.verbalizeDiagrams,
  };
}

/**
 * Shape a raw snapshot into a {@link UserProfile}.
 *
 * Applied explicitly rather than through `withConverter`, matching
 * `narrations.ts`. Document references do support converters under every
 * implementation we run against today, but keeping one reference kind on a
 * different mechanism from the others is how you end up with a capability gap
 * that only shows up at runtime.
 */
