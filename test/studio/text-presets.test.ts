import { describe, expect, it } from 'bun:test';
import {
  ONE_OFF,
  addPreset,
  createPreset,
  migrateDeliveryPresets,
  readSavedPresets,
  selectedPresetId,
} from '../../studio/src/lib/presets';
import { DELIVERY_PRESETS, MAX_SAVED_PRESETS } from '../../studio/src/lib/types';

const calm = { id: 'saved-calm', name: 'Calm', text: 'Creative. Calm. Intelligent. Interested.' };

describe('delivery and instruction presets', () => {
  it('keeps a pre-preset default delivery selectable as a saved preset', () => {
    expect(migrateDeliveryPresets(undefined, calm.text, DELIVERY_PRESETS)).toEqual([
      { id: 'saved-default', name: 'My default', text: calm.text },
    ]);
    expect(migrateDeliveryPresets(undefined, DELIVERY_PRESETS[0].text, DELIVERY_PRESETS)).toEqual([]);
    expect(migrateDeliveryPresets([], calm.text, DELIVERY_PRESETS)).toEqual([]);
  });

  it('drops malformed, duplicate, built-in, and excess saved presets', () => {
    const many = Array.from({ length: MAX_SAVED_PRESETS + 5 }, (_, i) => ({ id: `s${i}`, name: `P${i}`, text: 't' }));
    expect(readSavedPresets([calm, calm, { id: 'builtin:x', name: 'X', text: 't' }, { id: 'y', name: '', text: 't' }, null]))
      .toEqual([calm]);
    expect(readSavedPresets(many)).toHaveLength(MAX_SAVED_PRESETS);
    expect(readSavedPresets('nope')).toEqual([]);
  });

  it('selects the chosen preset, falls back to a matching one, and otherwise reports a one-off', () => {
    const presets = [...DELIVERY_PRESETS, calm];
    expect(selectedPresetId(presets, calm.text, calm.id)).toBe(calm.id);
    expect(selectedPresetId(presets, calm.text, undefined)).toBe(calm.id);
    expect(selectedPresetId(presets, 'Something new', undefined)).toBe(ONE_OFF);
    expect(selectedPresetId(presets, calm.text, ONE_OFF)).toBe(ONE_OFF);
    // A preset whose text has since changed no longer describes the draft.
    expect(selectedPresetId(presets, 'edited', calm.id)).toBe(ONE_OFF);
  });

  it('replaces a saved preset with the same name instead of duplicating it', () => {
    const updated = createPreset('calm', 'Slower now.');
    const saved = addPreset([calm], updated);
    expect(saved).toEqual([updated]);
    expect(updated.id.startsWith('builtin:')).toBe(false);
  });
});
