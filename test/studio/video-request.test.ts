import { describe, expect, it } from 'bun:test';
import { DEFAULT_VIDEO_REQUEST, parseVideoRequest, readVideoDefaults, videoActionBody } from '../../studio/src/lib/video-request';
import { WorkspaceStore } from '../../studio/src/lib/workspace';
import { workspaceItems } from '../../studio/src/lib/workspace-navigation';

describe('video request contract', () => {
  it('keeps source intact and defaults to direct landscape 720p with ten seconds', () => {
    expect(parseVideoRequest({ prompt: '# Notes\nA train moves.' })).toEqual({ ...DEFAULT_VIDEO_REQUEST, prompt: '# Notes\nA train moves.' });
    expect(readVideoDefaults({ ...DEFAULT_VIDEO_REQUEST, prompt: 'secret old source', referenceAssetId: 'old-reference' })).toEqual(DEFAULT_VIDEO_REQUEST);
  });
  it('rejects unsupported features and durations before accepting paid work', () => {
    for (const body of [{ prompt: '' }, { prompt: 'x'.repeat(32001) }, { prompt: 'film', task: 'edit' }, { prompt: 'film', model: 'other' },
      { prompt: 'film', output: { durationSeconds: 2 } }, { prompt: 'film', output: { durationSeconds: 10.5 } }, { prompt: 'film', output: { resolution: '8k' } },
      { prompt: 'film', output: { aspectRatio: '1:1' } }, { prompt: 'film', referenceRole: 'last_frame' }, { prompt: 'film', referenceAssetId: '../private' },
      { prompt: 'film', adaptation: { enabled: 'yes' } }, { prompt: 'film', adaptation: { instructions: 'x'.repeat(4001) } }]) expect(() => parseVideoRequest(body)).toThrow();
    expect(() => videoActionBody({ action: 'continue', prompt: 'next' })).toThrow();
    expect(() => videoActionBody({ action: 'edit_earlier', fromGenerationId: 'tip', prompt: 'next' })).toThrow();
    expect(videoActionBody({ action: 'regenerate_latest', fromGenerationId: 'tip', prompt: 'new' })).toEqual({ action: 'regenerate_latest', fromGenerationId: 'tip', settings: { prompt: 'new' } });
  });
  it('resolves continuation options from the saved snapshot and accepts one first frame or reference', () => {
    const defaults = parseVideoRequest({ prompt: 'first', output: { aspectRatio: '9:16', resolution: '1080p', durationSeconds: 4 } });
    expect(parseVideoRequest({ prompt: 'next', referenceAssetId: 'reference', referenceRole: 'first_frame' }, defaults)).toMatchObject({ output: defaults.output, referenceRole: 'first_frame' });
  });
});
describe('video workspace persistence', () => {
  it('restores references, instructions, pending request keys and pins independently of the other media', () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = new WorkspaceStore('owner'); first.initialize(storage, '/studio/video?draft=film');
    first.setVideoDraft('film', { kind: 'video', ...parseVideoRequest({ prompt: 'A train moves', referenceAssetId: 'reference', adaptation: { enabled: true, instructions: 'Keep the red color' } }) });
    first.setDraft('audio', { markdown: 'Read a poem' });
    first.setField(first.getSnapshot().activeId!, 'videoSubmission', JSON.stringify({ key: 'same-key-123', body: { prompt: 'A train moves' } }));
    first.togglePin(first.getSnapshot().activeId!); first.flush();
    const second = new WorkspaceStore('owner'); second.initialize(storage, '/library');
    expect(second.getSnapshot().videoDrafts?.film).toMatchObject({ prompt: 'A train moves', referenceAssetId: 'reference', adaptation: { instructions: 'Keep the red color' } });
    expect(second.getSnapshot().tabs.find(view => view.key === '/studio/video:film')!.fields.videoSubmission).toContain('same-key-123');
    expect(workspaceItems(second.getSnapshot()).find(item => item.draftId === 'film')).toMatchObject({ type: 'video', title: 'A train moves', pinned: true });
    expect(second.getSnapshot().drafts.audio.markdown).toBe('Read a poem');
    second.clearVideoDraft('film'); second.flush(); first.reconcile(); expect(first.getSnapshot().videoDrafts?.film).toBeUndefined();
    first.dispose(); second.dispose();
  });
});
