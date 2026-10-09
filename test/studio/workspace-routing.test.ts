import { describe, expect, it } from 'bun:test';
import { WorkspaceStore, workspaceRoute, type WorkspaceStorage } from '../../studio/src/lib/workspace';
import { createSceneDraft } from '../../studio/src/lib/scene-direction';

function memoryStorage(): WorkspaceStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, keys: () => [...values.keys()], removeItem: (key) => { values.delete(key); } };
}

describe('route-based workspace tabs', () => {
  it('keeps scene drafts and generated video ids independent and recoverable after closing a tab', () => {
    const storage = memoryStorage();
    const first = new WorkspaceStore('david'); first.restore(storage);
    const scene = first.visit('/studio/scene?draft=a')!;
    const draft = createSceneDraft(); draft.note = 'Keep this direction.';
    first.setSceneDraft('a', { draft, videoId: `v_${'a'.repeat(32)}` });
    first.visit('/studio/scene?draft=b'); first.setSceneDraft('b', { draft: { ...createSceneDraft(), frame: '9:16' } });
    first.visit('/studio?draft=a');
    expect(first.getSnapshot().tabs).toHaveLength(3);
    first.close(scene.id); first.flush();
    const refreshed = new WorkspaceStore('david'); refreshed.restore(storage);
    expect(refreshed.getSnapshot().sceneDrafts.a).toEqual({ draft, videoId: `v_${'a'.repeat(32)}` });
    expect(refreshed.getSnapshot().sceneDrafts.b.draft.frame).toBe('9:16');
    refreshed.visit('/studio/scene?draft=a');
    expect(refreshed.getSnapshot().sceneDrafts.a.draft.note).toBe('Keep this direction.');
    first.dispose(); refreshed.dispose();
  });

  it('opens any internal page and reuses its tab when the query or document mode changes', () => {
    const store = new WorkspaceStore('david');
    const library = store.visit('/library?q=running')!;
    store.visit('/settings');
    store.visit('/library?q=cycling');
    expect(store.getSnapshot().tabs).toHaveLength(2);
    expect(store.getSnapshot().activeId).toBe(library.id);
    expect(store.getSnapshot().tabs[0].href).toBe('/library?q=cycling');
    store.visit('/future-tool/some-item?view=details');
    expect(store.getSnapshot().tabs.at(-1)?.href).toBe('/future-tool/some-item?view=details');
    const narration = store.visit('/narration/article?doc=source')!;
    store.visit('/narration/article?doc=raw');
    expect(store.getSnapshot().activeId).toBe(narration.id);
    expect(store.getSnapshot().tabs.filter((tab) => tab.key === '/narration/article')).toHaveLength(1);
    store.dispose();
  });

  it('restores tabs, unfinished form edits, scroll positions, and independent drafts after refresh', () => {
    const storage = memoryStorage();
    const first = new WorkspaceStore('david');
    first.restore(storage);
    const draftA = first.visit('/studio?draft=a')!;
    first.setDraft('a', { markdown: '# First draft', promptStyle: 'Warm', speed: 0.75 });
    first.updateTab(draftA.id, { scrollTop: 420, title: 'First draft' });
    first.visit('/studio?draft=b');
    first.setDraft('b', { markdown: '# Second draft', promptStyle: 'Brisk', speed: 1.25 });
    const playlists = first.visit('/playlists?playlist=morning')!;
    first.setField(playlists.id, 'editTitle', 'Morning listening');
    first.flush();
    const refreshed = new WorkspaceStore('david');
    refreshed.restore(storage);
    expect(refreshed.getSnapshot().tabs).toHaveLength(3);
    expect(refreshed.getSnapshot().drafts.a).toEqual({ markdown: '# First draft', promptStyle: 'Warm', speed: 0.75 });
    expect(refreshed.getSnapshot().drafts.b).toEqual({ markdown: '# Second draft', promptStyle: 'Brisk', speed: 1.25 });
    expect(refreshed.getSnapshot().tabs[0].scrollTop).toBe(420);
    expect(refreshed.getSnapshot().tabs[2].fields.editTitle).toBe('Morning listening');
    // A direct link takes precedence over the last selected tab.
    refreshed.visit('/downloads?track=saved-song');
    expect(refreshed.getSnapshot().tabs.find((tab) => tab.id === refreshed.getSnapshot().activeId)?.href).toBe('/downloads?track=saved-song');
    first.dispose(); refreshed.dispose();
  });

  it('keeps closed drafts recoverable without interfering with unrelated open work', () => {
    const store = new WorkspaceStore('david');
    const draft = store.visit('/studio?draft=a')!;
    store.setDraft('a', { markdown: 'Keep this unfinished text.' });
    const narration = store.visit('/narration/playing')!;
    store.close(draft.id);
    expect(store.getSnapshot().activeId).toBe(narration.id);
    expect(store.getSnapshot().drafts.a.markdown).toBe('Keep this unfinished text.');
    store.visit('/studio?draft=a');
    expect(store.getSnapshot().drafts.a.markdown).toBe('Keep this unfinished text.');
    store.dispose();
  });

  it('follows browser history without creating duplicate tabs and closes the active tab to its neighbor', () => {
    const store = new WorkspaceStore('david');
    const library = store.visit('/library')!;
    const settings = store.visit('/settings')!;
    store.visit('/downloads');
    store.visit('/settings'); // Back
    store.visit('/library'); // Back
    store.visit('/settings'); // Forward
    expect(store.getSnapshot().tabs).toHaveLength(3);
    expect(store.close(settings.id)).toBe('/downloads');
    store.visit('/library');
    expect(store.getSnapshot().activeId).toBe(library.id);
    store.dispose();
  });

  it('preserves the workspace tab across generation and retries with a new narration ID', () => {
    const store = new WorkspaceStore('david');
    const draft = store.visit('/studio?draft=a')!;
    store.open('/narration/attempt-one', 'Article');
    expect(store.getSnapshot().activeId).toBe(draft.id); // Background activity does not steal focus.
    store.replaceTab(draft.id, '/narration/attempt-one', 'Article');
    store.visit('/narration/attempt-one');
    store.replaceTab(draft.id, '/narration/attempt-two', 'Article');
    store.visit('/narration/attempt-two');
    expect(store.getSnapshot().tabs).toHaveLength(1);
    expect(store.getSnapshot().activeId).toBe(draft.id);
    store.dispose();
  });

  it('scopes persisted work to its account and safely handles blocked or corrupt storage', () => {
    const storage = memoryStorage();
    const david = new WorkspaceStore('david');
    david.restore(storage);
    david.visit('/studio'); david.setDraft('default', { markdown: 'Private draft' }); david.flush();
    const someoneElse = new WorkspaceStore('someone-else'); someoneElse.restore(storage);
    expect(someoneElse.getSnapshot().tabs).toHaveLength(0);
    expect(someoneElse.getSnapshot().drafts).toEqual({});
    const blocked = new WorkspaceStore('blocked');
    blocked.restore({ getItem: () => '{broken', setItem: () => { throw new Error('Quota exceeded'); } });
    blocked.visit('/studio'); blocked.setDraft('default', { markdown: 'Still editable' }); blocked.flush();
    expect(blocked.isStorageUnavailable()).toBe(true);
    expect(blocked.getSnapshot().drafts.default.markdown).toBe('Still editable');
    david.dispose(); someoneElse.dispose(); blocked.dispose();
  });

  it('merges changes from another window instead of replacing its drafts or form edits', () => {
    const storage = memoryStorage();
    const first = new WorkspaceStore('david');
    first.restore(storage);
    const settings = first.visit('/settings')!;
    first.setDraft('a', { markdown: 'Original A', promptStyle: 'Warm' });
    first.flush();
    const second = new WorkspaceStore('david');
    second.restore(storage);
    first.setDraft('a', { markdown: 'Updated A' });
    first.setField(settings.id, 'delivery', 'Unfinished delivery');
    first.flush();
    second.setDraft('b', { markdown: 'New B' });
    second.setDraft('a', { promptStyle: 'Brisk' });
    second.setField(settings.id, 'invitee', 'pending@example.com');
    second.flush();
    const refreshed = new WorkspaceStore('david');
    refreshed.restore(storage);
    expect(refreshed.getSnapshot().drafts.a).toEqual({ markdown: 'Updated A', promptStyle: 'Brisk' });
    expect(refreshed.getSnapshot().drafts.b.markdown).toBe('New B');
    expect(refreshed.getSnapshot().tabs[0].fields).toEqual({ delivery: 'Unfinished delivery', invitee: 'pending@example.com' });
    first.reconcile();
    expect(first.getSnapshot().drafts.b.markdown).toBe('New B');
    first.dispose(); second.dispose(); refreshed.dispose();
  });

  it('preserves pending local edits when another window saves, and does not resurrect cleared drafts', () => {
    const storage = memoryStorage();
    const first = new WorkspaceStore('david'); first.restore(storage);
    first.setDraft('a', { markdown: 'A' }); first.setDraft('b', { markdown: 'B' }); first.flush();
    const second = new WorkspaceStore('david'); second.restore(storage);
    first.setDraft('a', { markdown: 'Pending edit' });
    second.clearDraft('b'); second.flush();
    first.reconcile(); first.flush();
    second.reconcile();
    expect(second.getSnapshot().drafts.a.markdown).toBe('Pending edit');
    expect(second.getSnapshot().drafts.b).toBeUndefined();
    first.dispose(); second.dispose();
  });

  it('serializes overlapping window saves and recovers a journal before its lock is granted', async () => {
    const storage = memoryStorage();
    const commits: Array<{ commit: () => void; resolve: () => void }> = [];
    storage.exclusive = (commit) => new Promise<void>((resolve) => { commits.push({ commit, resolve }); });
    const first = new WorkspaceStore('david'); first.restore(storage);
    const second = new WorkspaceStore('david'); second.restore(storage);
    first.setDraft('a', { markdown: 'Draft A' });
    second.setDraft('b', { markdown: 'Draft B' });
    const pendingA = first.flush();
    const pendingB = second.flush();
    // A refresh/page close can happen before either queued lock runs.
    const refreshed = new WorkspaceStore('david'); refreshed.restore(storage);
    expect(refreshed.getSnapshot().drafts.a.markdown).toBe('Draft A');
    expect(refreshed.getSnapshot().drafts.b.markdown).toBe('Draft B');
    // Run each commit under the same cross-window lock.
    for (const queued of commits.splice(0)) { queued.commit(); queued.resolve(); }
    await Promise.all([pendingA, pendingB]);
    first.reconcile(); second.reconcile();
    expect(first.getSnapshot().drafts.b.markdown).toBe('Draft B');
    expect(second.getSnapshot().drafts.a.markdown).toBe('Draft A');
    expect(storage.keys!().filter((key) => key.includes(':pending:'))).toHaveLength(0);
    storage.exclusive = undefined;
    first.dispose(); second.dispose(); refreshed.dispose();
  });

  it('does not report a newer failed save as successful when an older lock finishes', async () => {
    const storage = memoryStorage();
    const commits: Array<{ commit: () => void; resolve: () => void }> = [];
    storage.exclusive = (commit) => new Promise<void>((resolve) => { commits.push({ commit, resolve }); });
    const store = new WorkspaceStore('david'); store.restore(storage);
    store.setDraft('a', { markdown: 'Original' });
    const older = store.flush();
    const write = storage.setItem;
    storage.setItem = (key, value) => {
      if (key.includes(':pending:')) throw new Error('Quota exceeded');
      write(key, value);
    };
    store.setDraft('a', { markdown: 'Updated' }); store.flush();
    expect(store.isStorageUnavailable()).toBe(true);
    const oldCommit = commits.shift()!; oldCommit.commit(); oldCommit.resolve(); await older;
    expect(store.isStorageUnavailable()).toBe(true);
    expect(store.getSnapshot().drafts.a.markdown).toBe('Updated');
    const disk = new WorkspaceStore('david'); disk.restore(storage);
    expect(disk.getSnapshot().drafts.a.markdown).toBe('Original');
    storage.setItem = write;
    const retry = store.flush();
    const latest = commits.shift()!; latest.commit(); latest.resolve(); await retry;
    expect(store.isStorageUnavailable()).toBe(false);
    storage.exclusive = undefined;
    store.dispose(); disk.dispose();
  });

  it('keeps a complete valid tab when another window closes it during a pending local edit', () => {
    const storage = memoryStorage();
    const first = new WorkspaceStore('david'); first.restore(storage);
    const tab = first.visit('/settings')!; first.flush();
    const second = new WorkspaceStore('david'); second.restore(storage);
    second.updateTab(tab.id, { scrollTop: 20 });
    second.setField(tab.id, 'delivery', 'Keep this unfinished text');
    first.close(tab.id); first.flush();
    second.reconcile(); second.flush();
    expect(second.getSnapshot().tabs[0]).toMatchObject({
      id: tab.id, key: '/settings', href: '/settings', title: 'Settings', scrollTop: 20,
      fields: { delivery: 'Keep this unfinished text' },
    });
    const refreshed = new WorkspaceStore('david'); refreshed.restore(storage);
    expect(refreshed.getSnapshot().tabs[0].fields.delivery).toBe('Keep this unfinished text');
    first.dispose(); second.dispose(); refreshed.dispose();
  });

  it('keeps edits after failed or stale saves and clears only the acknowledged value', () => {
    const storage = memoryStorage();
    const store = new WorkspaceStore('david'); store.restore(storage);
    const profile = store.visit('/profile/david')!;
    store.setField(profile.id, 'name', 'First edit'); store.flush();
    // Dispatch and optimistic snapshots cannot erase this recoverable value.
    const refreshed = new WorkspaceStore('david'); refreshed.restore(storage);
    expect(refreshed.getSnapshot().tabs[0].fields.name).toBe('First edit');
    store.setField(profile.id, 'name', 'Newer edit');
    store.acknowledgeField(profile.id, 'name', 'First edit');
    expect(store.getSnapshot().tabs[0].fields.name).toBe('Newer edit');
    store.acknowledgeField(profile.id, 'name', 'Newer edit');
    expect(store.getSnapshot().tabs[0].fields.name).toBeNull();
    store.dispose(); refreshed.dispose();
  });

  it('does not restore external, API, or protocol-relative URLs as workspace pages', () => {
    for (const href of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/api/narrations', '/_next/static/chunk.js', '/']) {
      expect(workspaceRoute(href)).toBeNull();
    }
  });
});
