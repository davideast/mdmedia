import { describe, expect, it } from 'bun:test';
import { DEFAULT_IMAGE_REQUEST, parseImageRequest, readImageDefaults, readIdempotencyKey } from '../../studio/src/lib/image-request';
import { decideIdempotentReplay, executeImageJob } from '../../studio/src/lib/image-jobs';
import { WorkspaceStore } from '../../studio/src/lib/workspace';
import { workspaceItems, workPage } from '../../studio/src/lib/workspace-navigation';

describe('image request and job contract', () => {
  it('keeps Markdown intact and resolves omitted options without audio settings', () => {
    expect(parseImageRequest({ prompt: '# Notes\n\nA harbor.' })).toEqual({ ...DEFAULT_IMAGE_REQUEST, prompt: '# Notes\n\nA harbor.' });
    expect(parseImageRequest({ prompt: 'Draw', output: { aspectRatio: '1:1' } }).output).toEqual({ aspectRatio: '1:1', resolution: null });
    expect(readImageDefaults({ bad: true })).toEqual(DEFAULT_IMAGE_REQUEST);
  });
  it('rejects unsupported fields, limits, and invalid references before submission', () => {
    for (const body of [
      { prompt: '' },
      { prompt: 'x'.repeat(32_001) },
      { prompt: 'draw', provider: 'openai' },
      { prompt: 'draw', output: { resolution: '8K' } },
      { prompt: 'draw', referenceAssetId: '../other' },
      { prompt: 'draw', adaptation: { enabled: 'yes' } },
      { prompt: 'draw', model: 'dall-e-3' },
      { prompt: 'draw', model: 'gemini-3-pro-image', output: { aspectRatio: '1:4' } },
      { prompt: 'draw', model: 'gemini-nano-banana-2.1', output: { resolution: '0.5K' } },
      { prompt: 'draw', model: 'gemini-3.1-flash-lite-image', output: { resolution: '2K' } },
      { prompt: 'draw', model: 'gemini-3.1-flash-lite-image', searchGrounding: { web: true } },
      { prompt: 'draw', model: 'gemini-3-pro-image', searchGrounding: { imageSearch: true } },
      { prompt: 'draw', model: 'gemini-3.1-flash-image', thinkingLevel: 'medium' },
      { prompt: 'draw', model: 'gemini-3-pro-image', videoUri: 'https://www.youtube.com/watch?v=UTdfxFyOQTI' },
      { prompt: 'draw', videoUri: 'ftp://bad.example/video.mp4' },
      { prompt: 'draw', referenceAssetIds: Array.from({ length: 15 }, (_, i) => `asset_${i}`) },
    ]) {
      expect(() => parseImageRequest(body)).toThrow();
    }
    expect(() => readIdempotencyKey(new Request('http://studio'))).toThrow();
    expect(readIdempotencyKey(new Request('http://studio', { headers: { 'Idempotency-Key': 'unique-request-123' } }))).toBe('unique-request-123');
  });
  it('accepts Gemini 3.1/Nano Banana 2.1 models, extended ratios, 0.5K, up to 14 references, grounding, thinking, videoUri, and refine actions', () => {
    const parsed = parseImageRequest({
      prompt: 'Poster',
      model: 'gemini-3.1-flash-image',
      output: { aspectRatio: '1:8', resolution: '0.5K', mimeType: 'image/jpeg' },
      referenceAssetIds: ['ref_1', 'ref_2'],
      videoUri: 'https://www.youtube.com/watch?v=UTdfxFyOQTI',
      searchGrounding: { web: true, imageSearch: true },
      thinkingLevel: 'high',
      action: 'refine',
      fromGenerationId: 'gen_prev',
    });
    expect(parsed).toMatchObject({
      prompt: 'Poster',
      model: 'gemini-3.1-flash-image',
      output: { aspectRatio: '1:8', resolution: '0.5K', mimeType: 'image/jpeg' },
      referenceAssetId: 'ref_1',
      referenceAssetIds: ['ref_1', 'ref_2'],
      videoUri: 'https://www.youtube.com/watch?v=UTdfxFyOQTI',
      searchGrounding: { web: true, imageSearch: true },
      thinkingLevel: 'high',
      action: 'refine',
      fromGenerationId: 'gen_prev',
    });
    const replaced = parseImageRequest({ prompt: 'Single ref', referenceAssetId: 'ref_3' }, parsed);
    expect(replaced.referenceAssetId).toBe('ref_3');
    expect(replaced.referenceAssetIds).toBeUndefined();
    const cleared = parseImageRequest({ prompt: 'No refs', referenceAssetId: null }, parsed);
    expect(cleared.referenceAssetId).toBeNull();
    expect(cleared.referenceAssetIds).toBeUndefined();
  });
  it('distinguishes replay from changed-payload conflicts', () => {
    const stored = { requestHash: 'hash', itemId: 'image', generationId: 'attempt' };
    expect(decideIdempotentReplay(stored, 'hash')).toEqual({ kind: 'replay', itemId: 'image', generationId: 'attempt' });
    expect(decideIdempotentReplay(stored, 'other')).toEqual({ kind: 'conflict' });
  });
  it('adapts only when requested and saves only a successful provider result', async () => {
    const calls: string[] = [];
    const executor = { prepare: async () => { calls.push('adapt'); return 'visual'; }, generate: async (prompt: string) => { calls.push(prompt); return new Uint8Array([1]); }, checkpoint: async (phase: string) => { calls.push(phase); }, save: async () => { calls.push('saved'); } };
    await executeImageJob(parseImageRequest({ prompt: 'raw' }), executor);
    expect(calls).toEqual(['generating', 'raw', 'saving', 'saved']); calls.length = 0;
    await executeImageJob(parseImageRequest({ prompt: 'raw', adaptation: { enabled: true } }), executor);
    expect(calls).toEqual(['preparing', 'adapt', 'generating', 'visual', 'saving', 'saved']); calls.length = 0;
    await expect(executeImageJob(parseImageRequest({ prompt: 'raw' }), { ...executor, generate: async () => { throw new Error('provider failed'); } })).rejects.toThrow();
    expect(calls).not.toContain('saved');
  });
});

describe('mixed-media workspace persistence', () => {
  it('restores image drafts independently of narration and keeps pin/recent navigation', () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = new WorkspaceStore('user'); first.initialize(storage, '/studio/image?draft=image-draft');
    first.setImageDraft('image-draft', { kind: 'image', prompt: 'Draw Tokyo', aspectRatio: '1:1', resolution: '2K', adapt: true, instructions: 'Ink', referenceAssetId: 'reference' });
    first.setDraft('audio-draft', { markdown: 'Read Tokyo' }); first.togglePin(first.getSnapshot().activeId!); first.flush(); first.dispose();
    const second = new WorkspaceStore('user'); second.initialize(storage, '/library');
    expect(second.getSnapshot().imageDrafts?.['image-draft'].referenceAssetId).toBe('reference');
    expect(second.getSnapshot().drafts['audio-draft'].markdown).toBe('Read Tokyo');
    const items = workspaceItems(second.getSnapshot());
    expect(items.find(item => item.draftId === 'image-draft')).toMatchObject({ type: 'image', pinned: true, title: 'Draw Tokyo' });
    expect(workPage(items, 'Tokyo', 1).items).toHaveLength(2); second.dispose();
  });
});
