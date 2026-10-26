import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { emptyStoryboard, moveBeat, newBeat, parseStoryboard, restoreStoryboardDraft, storyboardHref, storyboardView } from '../../studio/src/lib/storyboard';
import { storyboardRoute } from '../../studio/src/lib/storyboard';
import { WorkspaceStore, workspaceRoute } from '../../studio/src/lib/workspace';
import { workspaceItems } from '../../studio/src/lib/workspace-navigation';

describe('working storyboards', () => {
  it('preserves walkthrough summaries independently of draft narration', () => {
    const document = parseStoryboard(JSON.parse(readFileSync('docs/storyboards/art-direction.storyboard.json', 'utf8')));
    expect(document.beats).toHaveLength(8);
    expect(document.beats.every(beat => beat.estimatedSeconds === null)).toBe(true);
    expect(document.beats[0]!.summary).not.toBe(document.beats[0]!.script);
    expect(parseStoryboard(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(() => parseStoryboard({ ...emptyStoryboard(), beats: [{ ...newBeat('a'), summary: 'x'.repeat(1201) }] })).toThrow('Summary');
  });
  it('round trips concept artwork and rejects external or traversing image paths', () => {
    const document = parseStoryboard(JSON.parse(readFileSync('docs/storyboards/intaglio-expanded.storyboard.json', 'utf8')));
    expect(document.beats).toHaveLength(11);
    expect(document.beats.every(beat => beat.image && beat.script && beat.visual)).toBe(true);
    expect(parseStoryboard(JSON.parse(JSON.stringify(document)))).toEqual(document);
    for (const image of ['https://example.com/tracker.png', '/assets/storyboard/../secret.png', '/assets/storyboard/a.svg', 'javascript:alert(1)']) {
      expect(() => parseStoryboard({ ...emptyStoryboard(), beats: [{ ...newBeat('a'), image }] })).toThrow('Concept image');
    }
  });
  it('loads the high-level screencast without requiring timing or finished script', () => {
    const document = parseStoryboard(JSON.parse(readFileSync('docs/storyboards/intaglio.storyboard.json', 'utf8')));
    expect(document.beats).toHaveLength(6);
    expect(document.beats.every(beat => beat.estimatedSeconds === null)).toBe(true);
    expect(document.beats.find(beat => beat.id === 'transformation')!.script).toBe('');
  });
  it('recovers oversized authored drafts without relaxing API save limits', () => {
    const document = { ...emptyStoryboard(), beats: Array.from({length:101}, (_, i) => ({...newBeat(`b${i}`), script: 'x'.repeat(8000)})) };
    const restored = restoreStoryboardDraft(JSON.parse(JSON.stringify(document)));
    expect(restored.beats).toHaveLength(101);
    expect(restored.beats[100]!.script).toBe('x'.repeat(8000));
    expect(() => parseStoryboard(restored)).toThrow('100 beats');
    expect(() => parseStoryboard({...restored, beats:restored.beats.slice(0,21)})).toThrow('160 KB');
    expect(() => restoreStoryboardDraft({...document,beats:[{...newBeat('a'),image:'javascript:alert(1)'}]})).toThrow('Concept image');
  });
  it('moves a whole beat without losing its identity or rewriting the source', () => {
    const before = { ...emptyStoryboard(), beats: [newBeat('a'), { ...newBeat('b'), notes: 'Keep this' }, newBeat('c')] };
    const after = moveBeat(before, 'b', -1);
    expect(after.beats.map(beat => beat.id)).toEqual(['b', 'a', 'c']);
    expect(after.beats[0]!.notes).toBe('Keep this');
    expect(before.beats.map(beat => beat.id)).toEqual(['a', 'b', 'c']);
    expect(moveBeat(before, 'a', -1)).toBe(before);
    expect(moveBeat(before, 'missing', 1)).toBe(before);
  });
  it('rejects duplicate ids, invalid durations, oversized text and unknown fields', () => {
    const beat = newBeat('a');
    for (const beats of [[beat, beat], [{ ...beat, id: '../a' }], [{ ...beat, estimatedSeconds: -1 }], [{ ...beat, title: '' }], [{ ...beat, script: 'x'.repeat(8001) }], [{ ...beat, newField: 'must not silently disappear' }]]) {
      expect(() => parseStoryboard({ ...emptyStoryboard(), beats })).toThrow();
    }
    expect(parseStoryboard({ ...emptyStoryboard(), beats: [{ ...beat, title: '' }] }, true).beats[0]!.title).toBe('');
    expect(() => parseStoryboard({ version: 2, premise: '', beats: [] })).toThrow();
  });
  it('recovers legacy storyboard routes without dropping pins or unsaved edits', () => {
    const draft = JSON.stringify({ document: { ...emptyStoryboard(), beats: [newBeat('unsaved')] }, revision: 3 });
    const saved = JSON.stringify({ version: 1, activeId: 'old-tab', tabs: [{
      id: 'old-tab', key: '/productions/p/storyboard', href: '/productions/p/storyboard?view=script&beat=unsaved',
      title: 'My story', pinned: true, visitedAt: 10, scrollTop: 120, fields: { storyboardDraft: draft },
    }] });
    const store = new WorkspaceStore('owner');
    store.restore({ getItem: () => saved, setItem: () => {} });
    expect(store.getSnapshot().tabs).toEqual([{
      id: 'old-tab', key: '/storyboards/p', href: '/storyboards/p?view=script&beat=unsaved',
      title: 'My story', pinned: true, visitedAt: 10, scrollTop: 120, fields: { storyboardDraft: draft },
    }]);
    expect(store.getSnapshot().activeId).toBe('old-tab');
    store.dispose();
  });
  it('treats Board and Script as one work item, independent of productions and cuts', () => {
    expect(storyboardRoute('/storyboards/p')).toBe('p');
    expect(storyboardRoute('/storyboards/p/extra')).toBeNull();
    expect(storyboardRoute('/storyboards/%zz')).toBeNull();
    expect(storyboardView('unsupported')).toBe('board');
    expect(workspaceRoute(storyboardHref('p', 'script', 'hook'))).toMatchObject({ key: '/storyboards/p', title: 'Storyboard' });
    const store = new WorkspaceStore('owner');
    store.visit('/productions/p');
    store.visit(storyboardHref('p', 'board', 'hook'));
    const view = store.getSnapshot().tabs.find(tab => tab.key === '/storyboards/p')!;
    store.setField(view.id, 'storyboardDraft', 'draft retained');
    store.updateTab(view.id, { title: 'Intaglio · Storyboard', pinned: true });
    store.visit(storyboardHref('p', 'script', 'hook'));
    store.visit('/productions/p/cuts/rough');
    expect(store.getSnapshot().tabs).toHaveLength(3);
    const items = workspaceItems(store.getSnapshot());
    expect(items.find(item => item.detail === 'Storyboard')).toMatchObject({ href: '/storyboards/p?view=script&beat=hook', pinned: true });
    expect(store.getSnapshot().tabs.find(tab => tab.id === view.id)!.fields.storyboardDraft).toBe('draft retained');
    expect(workspaceRoute('/productions/p/storyboard?view=script&beat=hook')).toMatchObject({key:'/storyboards/p',href:'/storyboards/p?view=script&beat=hook'});
    store.dispose();
  });
});
