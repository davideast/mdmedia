import { describe, expect, it } from 'bun:test';
import { WorkspaceStore, type WorkspaceSnapshot } from '../../studio/src/lib/workspace';
import { workspaceItems, workPage, matchesWork } from '../../studio/src/lib/workspace-navigation';
import { LIBRARY_SCAN_LIMIT, readLibraryCursor, readLibraryPage, type LibraryRecord } from '../../studio/src/lib/library-page';

describe('Library navigation', () => {
  it('upgrades old saved views without losing drafts, page queries, or unfinished fields', () => {
    const data = new Map([['mdmedia.workspace.v1:david', JSON.stringify({ version: 1, activeId: 'old',
      tabs: [{ id: 'old', href: '/library?q=notes', title: 'Library', scrollTop: 420, fields: { edit: 'unfinished' } }],
      drafts: { closed: { markdown: '# Closed draft', speed: 1.25 } } })]]);
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const store = new WorkspaceStore('david'); store.restore(storage);
    expect(store.getSnapshot().tabs[0].fields.edit).toBe('unfinished');
    expect(store.getSnapshot().tabs[0].scrollTop).toBe(420);
    expect(workspaceItems(store.getSnapshot())[0].title).toBe('Closed draft');
    const view = store.visit('/studio?draft=closed')!;
    store.togglePin(view.id); store.flush();
    const restored = new WorkspaceStore('david'); restored.restore(storage);
    expect(workspaceItems(restored.getSnapshot())[0].pinned).toBe(true);
    expect(restored.getSnapshot().drafts.closed.speed).toBe(1.25);
    store.dispose(); restored.dispose();
  });

  it('merges independent pins and edits from two windows', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const first = new WorkspaceStore('david'); first.restore(storage);
    const a = first.visit('/narration/a')!; const b = first.visit('/narration/b')!; first.flush();
    const second = new WorkspaceStore('david'); second.restore(storage);
    first.togglePin(a.id); second.togglePin(b.id);
    second.setDraft('draft', { markdown: '# Keep me' }); second.flush(); first.flush();
    second.reconcile();
    expect(workspaceItems(second.getSnapshot()).filter((item) => item.pinned)).toHaveLength(2);
    first.togglePin(a.id); first.flush(); second.reconcile();
    expect(workspaceItems(second.getSnapshot()).filter((item) => item.pinned).map((item) => item.key)).toEqual(['/narration/b']);
    expect(second.getSnapshot().drafts.draft.markdown).toBe('# Keep me');
    first.dispose(); second.dispose();
  });

  it('bounds route history while keeping pins, unfinished edits, and independent drafts', () => {
    const store = new WorkspaceStore('david');
    const pinned = store.visit('/narration/pinned')!; store.togglePin(pinned.id);
    const editing = store.visit('/profile/david')!; store.setField(editing.id, 'bio', 'Unfinished biography');
    store.visit('/studio?draft=old'); store.setDraft('old', { markdown: '# Old draft', speed: 0.75 });
    for (let i = 0; i < 200; i++) store.visit(`/narration/${i}`);
    const state = store.getSnapshot();
    expect(state.tabs.length).toBeLessThanOrEqual(102);
    expect(state.tabs.some((view) => view.id === pinned.id)).toBe(true);
    expect(state.tabs.find((view) => view.id === editing.id)?.fields.bio).toBe('Unfinished biography');
    expect(workspaceItems(state).some((item) => item.draftId === 'old')).toBe(true);
    expect(state.drafts.old.speed).toBe(0.75);
    store.dispose();
  });

  it('bounds a 10,000 document directory and distinguishes duplicate and Unicode titles', () => {
    const snapshot: WorkspaceSnapshot = { version: 1, activeId: null, drafts: {}, tabs: Array.from({ length: 10000 }, (_, i) => ({
      id: String(i), key: `/narration/${i}`, href: `/narration/${i}`, title: i === 9999 ? '東京 café notes' : 'Duplicate title',
      scrollTop: 0, fields: {}, visitedAt: i, pinned: i < 24,
    })) };
    const items = workspaceItems(snapshot);
    expect(workPage(items, '', 200).items).toHaveLength(50);
    expect(workPage(items, '', 200).page).toBe(200);
    expect(workPage(items, '', 201).page).toBe(200);
    expect(workPage(items, 'café 東京', 1).items[0].detail).toBe('Narration · 9999');
    expect(items.filter((item) => item.pinned)).toHaveLength(24);
    expect(matchesWork('Duplicate title 123', 'title 123')).toBe(true);
  });
});

describe('bounded library browsing', () => {
  const records: LibraryRecord[] = Array.from({ length: 1000 }, (_, i) => ({ id: String(i).padStart(4, '0'), data: {
    createdAt: Math.floor((1000 - i) / 3), title: i === 999 ? '東京 café notes' : 'Duplicate title', status: 'ready',
  } }));
  const source = async (cursor: { id: string } | null, size: number) => records.slice(cursor ? records.findIndex((item) => item.id === cursor.id) + 1 : 0, (cursor ? records.findIndex((item) => item.id === cursor.id) + 1 : 0) + size);

  it('pages past the old newest-100 limit without omitting tied timestamps', async () => {
    const ids: string[] = []; let cursor = null;
    do { const result = await readLibraryPage(source, '', cursor); expect(result.items.length).toBeLessThanOrEqual(50);
      ids.push(...result.items.map((item) => item.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toEqual(records.map((item) => item.id));
  });

  it('searches older work with bounded scans and a continuation cursor', async () => {
    const first = await readLibraryPage(source, '東京 café', null);
    expect(first.items).toHaveLength(0);
    expect(first.scanned).toBe(LIBRARY_SCAN_LIMIT);
    const second = await readLibraryPage(source, '東京 café', first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual(['0999']);
  });

  it('rejects malformed cursors and does not surface failed narrations', async () => {
    for (const value of ['{}', '{', '{"id":"a/b","createdAt":1}', '{"id":"a","createdAt":"2"}']) expect(() => readLibraryCursor(value)).toThrow();
    expect(readLibraryCursor(null)).toBeNull();
    const page = await readLibraryPage(async () => [{ id: 'error', data: { status: 'error', createdAt: 2 } }], '', null);
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});
