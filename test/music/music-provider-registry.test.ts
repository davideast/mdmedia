import { describe, expect, it } from 'bun:test';
import * as musicModule from '../../src/music/index.js';

describe('Music Provider Registry', () => {
  it('music subsystem exports MusicProviderRegistry and getMusicProvider', () => {
    const exportedKeys = Object.keys(musicModule);
    expect(exportedKeys).toContain('MusicProviderRegistry');
    expect(exportedKeys).toContain('getMusicProvider');
  });

  it('resolves lyria provider from registry with mock client', () => {
    const provider = (musicModule as any).getMusicProvider(
      'lyria',
      { interactions: {} } as any
    );
    expect(provider).toBeDefined();
    expect(typeof provider.generate).toBe('function');
  });

  it('returns undefined for unregistered provider names', () => {
    const provider = (musicModule as any).getMusicProvider('nonexistent');
    expect(provider).toBeUndefined();
  });
});
