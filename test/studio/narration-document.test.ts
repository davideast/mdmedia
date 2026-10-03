import { describe, expect, it } from 'bun:test';
import { observeNarrationDocument, type NarrationDocument } from '../../studio/src/lib/narration-document';
import type { Narration } from '../../studio/src/lib/types';
import type { NarrationTimingsFile } from '../../studio/src/lib/wav';

const narration = (id: string): Narration => ({ id, ownerUid: 'david', title: `Article ${id}`, sourceMarkdown: '# Source',
  transcript: 'Spoken article.', voice: 'Kore', promptStyle: 'Warm', adapted: true, status: 'ready', durationMs: 1000,
  audioPath: `${id}.wav`, timingsPath: `${id}.json`, visibility: 'private', sharedWith: [], authorName: 'David', authorPhoto: '', createdAt: 1, updatedAt: 1 });

describe('document viewing independent of playback', () => {
  it('reads narration text and alignment without constructing, loading, or pausing any audio player', async () => {
    let notify: (document: Narration | null) => void = () => {};
    let viewed: NarrationDocument | undefined;
    const stop = observeNarrationDocument('article', {
      watch: (_, receive) => { notify = receive; return () => {}; },
      timings: async () => ({ id: 'article', title: 'Article', transcript: 'Spoken article.', durationMs: 1000, chunks: [] }),
    }, (document) => { viewed = document; });
    notify(narration('article'));
    await Promise.resolve();
    expect(viewed?.id).toBe('article');
    expect(viewed?.transcript).toBe('Spoken article.');
    expect(viewed?.sourceMarkdown).toBe('# Source');
    expect(viewed?.status).toBe('ready');
    stop();
  });

  it('ignores a late checkpoint after switching documents and releases its listener', async () => {
    let notify: (document: Narration | null) => void = () => {};
    let complete: (timings: NarrationTimingsFile | null) => void = () => {};
    let detached = false;
    const deliveries: string[] = [];
    const stop = observeNarrationDocument('first', {
      watch: (_, receive) => { notify = receive; return () => { detached = true; }; },
      timings: () => new Promise((resolve) => { complete = resolve; }),
    }, (document) => { deliveries.push(document.title); });
    notify(narration('first'));
    stop();
    const count = deliveries.length;
    complete({ id: 'first', title: 'Late checkpoint', transcript: '', durationMs: 1000, chunks: [] });
    await Promise.resolve();
    expect(detached).toBe(true);
    expect(deliveries).toHaveLength(count);
  });

  it('reports missing and denied documents instead of leaving a permanent loading screen', () => {
    let notify: (document: Narration | null) => void = () => {};
    let deny: (error: Error) => void = () => {};
    let viewed: NarrationDocument | undefined;
    const stop = observeNarrationDocument('private', {
      watch: (_, receive, fail) => { notify = receive; deny = fail; return () => {}; },
      timings: async () => null,
    }, (document) => { viewed = document; });
    notify(null);
    expect(viewed?.status).toBe('error');
    deny(new Error('Permission denied'));
    expect(viewed?.errorMessage).toBe('Permission denied');
    stop();
  });
  it('requests fresh alignment on later checkpoints, including finalization at the same duration', async () => {
    let notify: (document: Narration | null) => void = () => {};
    let requests = 0;
    const stop = observeNarrationDocument('article', {
      watch: (_, receive) => { notify = receive; return () => {}; },
      timings: async () => { requests++; return null; },
    }, () => {});
    notify({ ...narration('article'), status: 'streaming', durationMs: 500 });
    notify({ ...narration('article'), status: 'streaming' });
    notify(narration('article'));
    await Promise.resolve();
    expect(requests).toBe(3);
    stop();
  });

  it('does not publish an in-flight alignment after permission is lost', async () => {
    let deny: (error: Error) => void = () => {};
    let complete: (file: NarrationTimingsFile | null) => void = () => {};
    let viewed: NarrationDocument | undefined;
    const stop = observeNarrationDocument('article', {
      watch: (_, receive, fail) => { deny = fail; receive(narration('article')); return () => {}; },
      timings: () => new Promise((resolve) => { complete = resolve; }),
    }, (document) => { viewed = document; });
    deny(new Error('Permission denied'));
    complete({ id: 'article', title: 'Article', transcript: 'Private text', durationMs: 1000, chunks: [] });
    await Promise.resolve();
    expect(viewed?.status).toBe('error');
    expect(viewed?.transcript).toBe('');
    expect(viewed?.sourceMarkdown).toBeNull();
    stop();
  });
});
