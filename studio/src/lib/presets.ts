import {
  MAX_PRESET_NAME,
  MAX_PRESET_TEXT,
  MAX_SAVED_PRESETS,
  type TextPreset,
} from './types';

/** The selection that means "this narration only; not saved as a preset". */
export const ONE_OFF = 'one-off';

function isPreset(value: unknown): value is TextPreset {
  const preset = value as Partial<TextPreset> | null;
  return typeof preset?.id === 'string' && preset.id.length > 0 && !preset.id.startsWith('builtin:') &&
    typeof preset.name === 'string' && preset.name.trim().length > 0 && preset.name.length <= MAX_PRESET_NAME &&
    typeof preset.text === 'string' && preset.text.length <= MAX_PRESET_TEXT;
}

/** Saved presets as stored, minus anything malformed, duplicated, or past the cap. */
export function readSavedPresets(value: unknown): TextPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: TextPreset[] = [];
  for (const item of value) {
    if (!isPreset(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    presets.push({ id: item.id, name: item.name.trim(), text: item.text });
    if (presets.length === MAX_SAVED_PRESETS) break;
  }
  return presets;
}

/**
 * Settings written before presets existed have a free-text default delivery.
 * Keep it selectable by turning it into the first saved preset.
 */
export function migrateDeliveryPresets(saved: unknown, defaultText: string, builtIns: readonly TextPreset[]): TextPreset[] {
  if (Array.isArray(saved)) return readSavedPresets(saved);
  if (!defaultText.trim() || builtIns.some((preset) => preset.text === defaultText)) return [];
  return [{ id: 'saved-default', name: 'My default', text: defaultText }];
}

/** Which preset a draft is using: its explicit choice, else the preset whose text it matches. */
export function selectedPresetId(presets: readonly TextPreset[], text: string, choice: string | undefined): string {
  if (choice === ONE_OFF) return ONE_OFF;
  const chosen = choice ? presets.find((preset) => preset.id === choice) : undefined;
  if (chosen && chosen.text === text) return chosen.id;
  return presets.find((preset) => preset.text === text)?.id ?? ONE_OFF;
}

export function createPreset(name: string, text: string): TextPreset {
  const id = `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return { id, name: name.trim().slice(0, MAX_PRESET_NAME), text: text.slice(0, MAX_PRESET_TEXT) };
}

/** Adds a preset, replacing one with the same name so saving twice does not duplicate it. */
export function addPreset(saved: readonly TextPreset[], preset: TextPreset): TextPreset[] {
  const name = preset.name.toLowerCase();
  const kept = saved.filter((item) => item.name.toLowerCase() !== name);
  return [...kept, preset].slice(-MAX_SAVED_PRESETS);
}
