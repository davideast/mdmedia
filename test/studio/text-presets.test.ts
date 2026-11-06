import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ONE_OFF,
  addPreset,
  createPreset,
  deletePreset,
  duplicatePresetDraft,
  isBuiltInPreset,
  migrateDeliveryPresets,
  readSavedPresets,
  selectedPresetId,
  updatePreset,
} from '../../studio/src/lib/presets';
import { DELIVERY_PRESETS, INSTRUCTION_PRESETS, MAX_SAVED_PRESETS } from '../../studio/src/lib/types';

const calm = { id: 'saved-calm', name: 'Calm', text: 'Creative. Calm. Intelligent. Interested.' };
const brisk = { id: 'saved-brisk', name: 'Brisk', text: 'Informative. Fast paced.' };

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

  it('updates a saved preset in place and synchronizes defaultText when the edited preset is the active default', () => {
    const result = updatePreset(
      [calm, brisk],
      calm.id,
      { name: 'Calm & Measured', text: 'Calm, thoughtful, and unhurried.' },
      calm.text,
    );
    expect(result.presets).toEqual([
      { id: calm.id, name: 'Calm & Measured', text: 'Calm, thoughtful, and unhurried.' },
      brisk,
    ]);
    expect(result.defaultText).toBe('Calm, thoughtful, and unhurried.');
    expect(selectedPresetId([...DELIVERY_PRESETS, ...result.presets], result.defaultText, undefined)).toBe(calm.id);
  });

  it('preserves defaultText when updating a saved preset that is not the active default', () => {
    const result = updatePreset(
      [calm, brisk],
      brisk.id,
      { name: 'Rapid Briefing', text: 'Fast, crisp executive summary.' },
      calm.text,
    );
    expect(result.presets).toEqual([
      calm,
      { id: brisk.id, name: 'Rapid Briefing', text: 'Fast, crisp executive summary.' },
    ]);
    expect(result.defaultText).toBe(calm.text);
  });

  it('deletes a saved preset and falls back defaultText to the built-in default when the active default is removed', () => {
    const deletedActive = deletePreset([calm, brisk], calm.id, calm.text, DELIVERY_PRESETS[0].text);
    expect(deletedActive.presets).toEqual([brisk]);
    expect(deletedActive.defaultText).toBe(DELIVERY_PRESETS[0].text);

    const deletedInactive = deletePreset([calm, brisk], brisk.id, calm.text, DELIVERY_PRESETS[0].text);
    expect(deletedInactive.presets).toEqual([calm]);
    expect(deletedInactive.defaultText).toBe(calm.text);
  });

  it('distinguishes built-in presets and generates non-colliding duplicate drafts', () => {
    expect(isBuiltInPreset(DELIVERY_PRESETS[0])).toBe(true);
    expect(isBuiltInPreset(INSTRUCTION_PRESETS[0])).toBe(true);
    expect(isBuiltInPreset(calm)).toBe(false);

    const firstCopy = duplicatePresetDraft(DELIVERY_PRESETS[0], [...DELIVERY_PRESETS, calm]);
    expect(firstCopy).toEqual({
      name: 'Warm and unhurried (copy)',
      text: DELIVERY_PRESETS[0].text,
    });

    const secondCopy = duplicatePresetDraft(DELIVERY_PRESETS[0], [
      ...DELIVERY_PRESETS,
      { id: 'saved-copy-1', name: 'Warm and unhurried (copy)', text: DELIVERY_PRESETS[0].text },
    ]);
    expect(secondCopy).toEqual({
      name: 'Warm and unhurried (copy 2)',
      text: DELIVERY_PRESETS[0].text,
    });
  });

  it('consolidates default selection and editable preset management in Settings without separate inventory rows', () => {
    const settingsSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/app/(app)/settings/page.tsx'),
      'utf8',
    );
    const presetListSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/components/studio/preset-list.tsx'),
      'utf8',
    );

    expect(settingsSource).not.toContain('label="Delivery presets"');
    expect(settingsSource).not.toContain('label="Instruction presets"');
    expect(settingsSource).toContain('stacked\n                label="Delivery"');
    expect(settingsSource).toContain('stacked\n            label="Custom instructions"');
    expect(presetListSource).toContain('Duplicate & edit');
    expect(presetListSource).toContain('Save changes');
    expect(presetListSource).toContain('Use as default');
  });
});
