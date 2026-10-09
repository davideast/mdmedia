import { describe, expect, test } from 'bun:test';
import { resolveConfig } from '../../src/config/config-resolver.js';
import { resolveImageSelection, validateImageRequest } from '../../src/image/selection.js';
import type { ImageProviderName, ImageRequest } from '../../src/image/types.js';
import { PNG, RGB_PNG_WITH_TRANSPARENCY } from './helpers.js';

describe('image selection and validation before submission', () => {
  test('keeps legacy Gemini default, image config and generic legacy key', () => {
    expect(resolveImageSelection({ legacyApiKey: 'legacy', env: {} })).toMatchObject({ provider: 'gemini', model: 'gemini-3-pro-image', aspectRatio: '16:9', apiKey: 'legacy' });
    expect(resolveConfig({ mode: 'image', apiKey: 'cli' }, { image: { provider: 'openai', model: 'gpt-image-2.5-flare' } }, {}).image).toMatchObject({ provider: 'openai', model: 'gpt-image-2.5-flare', apiKey: 'cli' });
    expect(resolveConfig({ mode: 'image' }, { image: { provider: 'openai' } }, { OPENAI_API_KEY: 'oa', GEMINI_API_KEY: 'gm' }).apiKey).toBe('oa');
  });
  test('isolates keys, models and options on an explicit or environment provider switch', () => {
    const configured = { provider: 'gemini', model: 'custom', apiKey: 'gemini-secret', aspectRatio: '16:9', referenceImage: 'old.png' };
    expect(resolveImageSelection({ requested: { provider: 'pixellab' }, configured, legacyApiKey: 'legacy', env: { PIXELLAB_API_KEY: 'pixel-secret' } })).toEqual({ provider: 'pixellab', model: 'pixflux', apiKey: 'pixel-secret', size: '128x128' });
    expect(resolveImageSelection({ configured, env: { MDMEDIA_IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: 'openai' } }).provider).toBe('gemini');
    expect(resolveImageSelection({ env: { MDMEDIA_IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: 'openai', GEMINI_API_KEY: 'gemini' } }).apiKey).toBe('openai');
    expect(resolveImageSelection({ requested: { provider: 'openai' }, legacyApiKey: 'gemini', env: {} }).apiKey).toBeUndefined();
  });
  test('CLI size overrides configured aspect and undefined args preserve file options', () => {
    expect(resolveImageSelection({ requested: { size: '1024x1024', quality: undefined }, configured: { provider: 'openai', aspectRatio: '16:9', quality: 'high' }, env: {} })).toMatchObject({ size: '1024x1024', aspectRatio: undefined, quality: 'high' });
    expect(resolveImageSelection({ requested: { aspectRatio: '1:1' }, configured: { provider: 'openai', size: '1536x1024' }, env: {} }).size).toBeUndefined();
  });
  test('keeps Gemini resolution presets alongside requested or configured aspect ratios', () => {
    const configured = { provider: 'gemini', size: '2K', aspectRatio: '3:2' };
    const selection = resolveImageSelection({ configured, requested: { size: '4k' }, env: {} });
    expect(validateImageRequest('gemini', { ...selection, prompt: 'Village', format: 'png' })).toMatchObject({ size: '4K', aspectRatio: '3:2' });
    expect(resolveImageSelection({ configured, requested: { aspectRatio: '1:1' }, env: {} })).toMatchObject({ size: '2K', aspectRatio: '1:1' });
    expect(resolveImageSelection({ requested: { size: '1K' }, env: {} })).toMatchObject({ size: '1K', aspectRatio: '16:9' });
  });
  test('maps aspect ratios to exact GPT Image 2.5 size and supports both variants/snapshots', () => {
    for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08']) {
      expect(validateImageRequest('openai', { model, prompt: 'Red fox', aspectRatio: '16:9', format: 'png', quality: 'max' }).size).toBe('1536x864');
    }
  });
  const cases: [ImageProviderName, Partial<ImageRequest>, string][] = [
    ['openai', { model: 'gpt-image-2.5' }, 'model must'],
    ['openai', { size: '128x128' }, '655360'],
    ['openai', { size: '1537x1024' }, 'multiples'],
    ['openai', { size: '4096x2048' }, '3840'],
    ['openai', { size: 'auto', aspectRatio: '16:9' }, 'either'],
    ['openai', { seed: 1 }, 'seed'],
    ['openai', { format: 'jpeg', background: 'transparent' }, 'Transparent'],
    ['gemini', { size: '1024x1024' }, '1K, 2K or 4K'],
    ['gemini', { background: 'transparent' }, 'background'],
    ['pixellab', { model: 'pixen', size: '127x128' }, 'multiples'],
    ['pixellab', { model: 'pixen', reference: { bytes: PNG, mimeType: 'image/png' } }, 'does not support'],
    ['pixellab', { size: '400x400', background: 'transparent' }, '200x200'],
    ['pixellab', { quality: 'high' }, 'quality'],
    ['pixellab', { aspectRatio: '1:1' }, 'native'],
    ['pixellab', { format: 'jpeg' }, 'PNG'],
    ['retrodiffusion', { model: 'rd_fast', size: '512x512' }, '64–384'],
    ['retrodiffusion', { style: 'rd_pro__default' }, 'matching'],
    ['retrodiffusion', { reference: { bytes: PNG, mimeType: 'image/jpeg' } }, 'MIME'],
    ['retrodiffusion', { reference: { bytes: RGB_PNG_WITH_TRANSPARENCY, mimeType: 'image/png' } }, 'without transparency'],
    ['retrodiffusion', { seed: NaN }, 'seed'],
  ];
  for (const [provider, overrides, error] of cases) {
    test(`rejects ${provider} ${JSON.stringify(overrides)} locally`, () => {
      const selection = resolveImageSelection({ requested: { provider, size: overrides.size, aspectRatio: overrides.aspectRatio }, env: {} });
      expect(() => validateImageRequest(provider, { prompt: 'Red fox', format: 'png', ...selection, ...overrides })).toThrow(error);
    });
  }
});
