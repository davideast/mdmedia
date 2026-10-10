import { describe, expect, it } from 'bun:test';
import { DEFAULT_MUSIC_REQUEST, parseMusicRequest, readMusicDefaults, musicPrompt } from '../../studio/src/lib/music-request';
import { WorkspaceStore, workspaceRoute } from '../../studio/src/lib/workspace';
import { workspaceItems } from '../../studio/src/lib/workspace-navigation';
describe('music intent and saved drafts', () => {
  it('requires only a prompt and composes explicit musical directions without native live controls', () => {
    expect(parseMusicRequest({ prompt: 'Piano' })).toEqual({ ...DEFAULT_MUSIC_REQUEST, prompt: 'Piano' });
    expect(musicPrompt(parseMusicRequest({ prompt: 'Piano', vocals: 'instrumental' }))).toContain('No vocals');
    expect(musicPrompt(parseMusicRequest({ prompt: 'Piano', lyrics: '[Verse]\nHello' }))).toContain('Sing these lyrics:\n[Verse]\nHello');
  });
  it('rejects unsupported controls and contradictory or malformed input', () => {
    for (const patch of [{ bpm: 100 }, { output: { durationSeconds: 60 } }, { output: { mode: 'live' } }, { output: { format: 'ogg' } }, { vocals: 'instrumental', lyrics: 'Hello' }, { lyrics: null }, { prompt: '' }, { referenceAssetId: '../secret' }]) {
      expect(() => parseMusicRequest({ prompt: 'Piano', ...patch })).toThrow();
    }
  });
  it('saves preferences without retaining lyrics or a source reference', () => {
    expect(readMusicDefaults({ ...DEFAULT_MUSIC_REQUEST, vocals: 'vocals', lyrics: 'Private', referenceAssetId: 'ref' })).toEqual({ ...DEFAULT_MUSIC_REQUEST, vocals: 'vocals' });
    expect(readMusicDefaults({ output: { mode: 'invalid' } })).toEqual(DEFAULT_MUSIC_REQUEST);
  });
  it('persists discoverable music drafts across reload and recognizes saved work', () => {
    const saved = new Map<string, string>(); const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const store = new WorkspaceStore('music-test'); store.restore(storage);
    store.setMusicDraft('track', { ...DEFAULT_MUSIC_REQUEST, kind: 'music', prompt: 'Quiet piano', lyrics: 'Hello' });
    store.flush();
    const reloaded = new WorkspaceStore('music-test'); reloaded.restore(storage);
    expect(reloaded.getSnapshot().musicDrafts?.track.prompt).toBe('Quiet piano');
    expect(workspaceItems(reloaded.getSnapshot()).find(item => item.type === 'music')?.href).toBe('/studio/music?draft=track');
    expect(workspaceRoute('/studio/music?draft=track')?.key).toBe('/studio/music:track');
    store.clearMusicDraft('track'); store.flush();
    const cleared = new WorkspaceStore('music-test'); cleared.restore(storage);
    expect(cleared.getSnapshot().musicDrafts?.track).toBeUndefined();
    store.dispose(); reloaded.dispose(); cleared.dispose();
  });
});
