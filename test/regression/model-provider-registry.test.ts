import { describe, expect, it } from 'bun:test';
import * as ttsModule from '../../src/tts/index.js';

describe('Insight d45ea8b2: Hardcoded Gemini Flash dispatch bypasses provider registry', () => {
  it('TTS subsystem exports a declarative ProviderRegistry and getTTSProvider', () => {
    const exportedKeys = Object.keys(ttsModule);
    const hasRegistry = exportedKeys.includes('ProviderRegistry') && exportedKeys.includes('getTTSProvider');

    expect(hasRegistry).toBe(true);

    const provider = (ttsModule as any).getTTSProvider('gemini', { interactions: {} } as any);
    expect(provider).toBeDefined();
    expect(typeof provider.streamAudio).toBe('function');
  });
});
