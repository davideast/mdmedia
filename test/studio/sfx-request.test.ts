import { describe, expect, it } from 'bun:test';
import { DEFAULT_SFX_REQUEST, parseSfxRequest, readSfxDefaults } from '../../studio/src/lib/sfx-request';
import { MEDIA_TYPES } from '../../studio/src/lib/media-types';
describe('sound effect intent', () => {
  it('requires only a prompt and lets the model choose the length by default', () => {
    expect(parseSfxRequest({ prompt: 'Door creak' })).toEqual({ ...DEFAULT_SFX_REQUEST, prompt: 'Door creak' });
    expect(DEFAULT_SFX_REQUEST).toEqual({ prompt: '', output: { format: 'mp3', durationSeconds: null, loop: false }, promptInfluence: 0.3 });
    expect(parseSfxRequest({ prompt: 'Rain', output: { format: 'wav', durationSeconds: 0.5, loop: true }, promptInfluence: 1 }))
      .toEqual({ prompt: 'Rain', output: { format: 'wav', durationSeconds: 0.5, loop: true }, promptInfluence: 1 });
  });
  it('merges a partial new attempt over the saved request', () => {
    const saved = parseSfxRequest({ prompt: 'Rain', output: { format: 'wav', durationSeconds: 4, loop: true }, promptInfluence: 0.8 });
    expect(parseSfxRequest({ output: { durationSeconds: null } }, saved)).toEqual({ ...saved, output: { ...saved.output, durationSeconds: null } });
    expect(parseSfxRequest({ prompt: 'Thunder' }, saved)).toEqual({ ...saved, prompt: 'Thunder' });
  });
  it('rejects unsupported controls and malformed input with stable codes', () => {
    for (const [patch, code] of [
      [{ lyrics: 'x' }, 'unknown_fields'], [{ output: { mode: 'clip' } }, 'unknown_fields'], [{ adaptation: { enabled: true } }, 'unknown_fields'], [{ referenceAssetId: 'ref' }, 'unknown_fields'],
      [{ prompt: '' }, 'invalid_prompt'], [{ prompt: '   ' }, 'invalid_prompt'], [{ prompt: 'x'.repeat(4001) }, 'invalid_prompt'], [{ prompt: 4 }, 'invalid_prompt'],
      [{ output: { format: 'ogg' } }, 'invalid_format'], [{ output: { format: null } }, 'invalid_format'],
      [{ output: { durationSeconds: 0.4 } }, 'invalid_duration'], [{ output: { durationSeconds: 30.5 } }, 'invalid_duration'], [{ output: { durationSeconds: '5' } }, 'invalid_duration'],
      [{ output: { loop: 'yes' } }, 'invalid_loop'], [{ output: { loop: null } }, 'invalid_loop'],
      [{ promptInfluence: -0.1 }, 'invalid_influence'], [{ promptInfluence: 1.1 }, 'invalid_influence'], [{ promptInfluence: null }, 'invalid_influence'],
      [{ output: [] }, 'invalid_body'],
    ] as const) expect(() => parseSfxRequest({ prompt: 'Door creak', ...patch })).toThrow(expect.objectContaining({ code }));
    expect(() => parseSfxRequest({})).toThrow(expect.objectContaining({ code: 'invalid_prompt' }));
    expect(parseSfxRequest({ prompt: 'x'.repeat(4000) }).prompt.length).toBe(4000);
  });
  it('reads saved preferences without retaining a prompt', () => {
    expect(readSfxDefaults({ prompt: 'Private', output: { format: 'wav' }, promptInfluence: 0.5 })).toEqual({ ...DEFAULT_SFX_REQUEST, output: { ...DEFAULT_SFX_REQUEST.output, format: 'wav' }, promptInfluence: 0.5 });
    expect(readSfxDefaults({ output: { format: 'ogg' } })).toEqual(DEFAULT_SFX_REQUEST);
    expect(readSfxDefaults(undefined)).toEqual(DEFAULT_SFX_REQUEST);
  });
  it('is a known media type without a create option', () => {
    expect(MEDIA_TYPES.find(item => item.type === 'sfx')).toEqual({ type: 'sfx', label: 'Sound effect', composer: '/studio/sfx', available: false });
  });
});
