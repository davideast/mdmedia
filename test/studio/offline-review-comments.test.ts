import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INITIAL_CONNECTIVITY,
  OFFLINE_AFTER_FAILURES,
  nextConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from '../../studio/src/lib/connectivity';
import {
  clearDraft,
  draftKey,
  readDraft,
  saveDraft,
  unsentComments,
  type DraftStorage,
  type DraftTarget,
} from '../../studio/src/lib/comment-drafts';

/**
 * The owner kept losing long review comments: one slow health check on a busy
 * machine made Studio "offline", which locked the whole page, and the comment
 * lived only in memory. Now Studio waits for several failures in a row, the
 * page stays usable, and every comment and reply is kept as it is typed.
 */

const run = (events: ConnectivityEvent['type'][], from: ConnectivityState = INITIAL_CONNECTIVITY) =>
  events.reduce((state, type) => nextConnectivity(state, { type }), from);

describe('when Studio counts as offline', () => {
  it('waits for three failed checks in a row', () => {
    expect(OFFLINE_AFTER_FAILURES).toBe(3);
    const online = run(['check-succeeded']);
    expect(run(['check-failed'], online).status).toBe('online');
    expect(run(['check-failed', 'check-failed'], online).status).toBe('online');
    expect(run(['check-failed', 'check-failed', 'check-failed'], online)).toEqual({ status: 'offline', failures: 3 });
  });

  it('starts over after a good check, so scattered slow checks never add up', () => {
    const state = run(['check-succeeded', 'check-failed', 'check-failed', 'check-succeeded', 'check-failed', 'check-failed']);
    expect(state).toEqual({ status: 'online', failures: 2 });
  });

  it('stays checking, not offline, while the first checks fail on load', () => {
    expect(run(['check-failed', 'check-failed']).status).toBe('checking');
    expect(run(['check-failed', 'check-failed', 'check-failed']).status).toBe('offline');
  });

  it('comes back online on one good check', () => {
    const offline = run(['check-failed', 'check-failed', 'check-failed', 'check-failed']);
    expect(offline.status).toBe('offline');
    expect(run(['check-succeeded'], offline)).toEqual({ status: 'online', failures: 0 });
  });

  it('believes the browser at once when it has no network', () => {
    expect(run(['check-succeeded', 'browser-offline']).status).toBe('offline');
    // A failure after that keeps it offline; a good check after the network returns recovers.
    expect(run(['check-succeeded', 'browser-offline', 'check-failed']).status).toBe('offline');
    expect(run(['check-succeeded', 'browser-offline', 'check-succeeded']).status).toBe('online');
  });
});

class MemoryStorage implements DraftStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

const throwing: DraftStorage = {
  get length(): number { throw new Error('blocked'); },
  key() { throw new Error('blocked'); },
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('quota'); },
  removeItem() { throw new Error('blocked'); },
};

const comment = (time: number, cutId = 'take6'): DraftTarget => ({ kind: 'comment', productionId: 'prod-1', cutId, time });
const reply: DraftTarget = { kind: 'reply', productionId: 'prod-1', threadId: 'thread-9' };

describe('review comment drafts', () => {
  it('keeps a new comment by production, cut and time, and gives it back when reopened', () => {
    const storage = new MemoryStorage();
    expect(saveDraft(comment(12.345), 'The cut at the door lands a beat late.', storage)).toBe(true);
    expect(readDraft(comment(12.345), storage)).toBe('The cut at the door lands a beat late.');
    expect(readDraft(comment(12.346), storage)).toBe('');
    expect(readDraft(comment(12.345, 'take7'), storage)).toBe('');
    expect(readDraft({ ...comment(12.345), productionId: 'prod-2' } as DraftTarget, storage)).toBe('');
  });

  it('keeps replies by production and thread', () => {
    const storage = new MemoryStorage();
    saveDraft(reply, 'Option B, but keep the music.', storage);
    expect(readDraft(reply, storage)).toBe('Option B, but keep the music.');
    expect(readDraft({ ...reply, threadId: 'thread-10' }, storage)).toBe('');
    expect(draftKey(reply)).not.toBe(draftKey(comment(0)));
  });

  it('lists a cut\'s unposted comments, earliest first, so a reload can reopen them', () => {
    const storage = new MemoryStorage();
    saveDraft(comment(40), 'second', storage, 2);
    saveDraft(comment(3.5), 'first', storage, 1);
    saveDraft(comment(9, 'take7'), 'another cut', storage);
    saveDraft(reply, 'a reply', storage);
    expect(unsentComments('prod-1', 'take6', storage)).toEqual([
      { time: 3.5, text: 'first', savedAt: 1 },
      { time: 40, text: 'second', savedAt: 2 },
    ]);
  });

  it('clears a draft only when asked, and blank text removes it', () => {
    const storage = new MemoryStorage();
    saveDraft(comment(1), 'keep me', storage);
    expect(unsentComments('prod-1', 'take6', storage)).toHaveLength(1);
    clearDraft(comment(1), storage);
    expect(readDraft(comment(1), storage)).toBe('');
    saveDraft(comment(2), 'typed', storage);
    saveDraft(comment(2), '   ', storage);
    expect(unsentComments('prod-1', 'take6', storage)).toEqual([]);
  });

  it('ignores damaged entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(draftKey(comment(5)), '{not json');
    storage.setItem(draftKey(comment(6)), JSON.stringify({ text: 42 }));
    expect(readDraft(comment(5), storage)).toBe('');
    expect(unsentComments('prod-1', 'take6', storage)).toEqual([]);
  });

  it('never throws when storage is missing or refuses', () => {
    expect(saveDraft(comment(1), 'text', null)).toBe(false);
    expect(readDraft(comment(1), null)).toBe('');
    expect(unsentComments('prod-1', 'take6', null)).toEqual([]);
    expect(saveDraft(comment(1), 'text', throwing)).toBe(false);
    expect(readDraft(comment(1), throwing)).toBe('');
    expect(() => clearDraft(comment(1), throwing)).not.toThrow();
    expect(unsentComments('prod-1', 'take6', throwing)).toEqual([]);
  });
});

describe('Studio offline, as the page shows it', () => {
  const source = (path: string) => readFileSync(resolve(import.meta.dir, '../../studio/src', path), 'utf8');

  it('keeps the workspace usable instead of locking it', () => {
    const shell = source('components/shell/app-shell.tsx');
    expect(shell).not.toContain('inert=');
    expect(shell).toContain('id="workspace-page"');
    expect(shell).toContain('Studio can&rsquo;t reach its server');
  });

  it('keeps comment and reply text editable and saved, and holds only the post while offline', () => {
    const panel = source('components/cut/comments-panel.tsx');
    expect(panel).toContain("useDraftText({ kind: 'comment'");
    expect(panel).toContain("useDraftText({ kind: 'reply'");
    expect(panel).toMatch(/disabled=\{!text\.trim\(\) \|\| sending \|\| offline\}[^>]*>\{offline \? OFFLINE_POST : 'Comment'\}/);
    expect(panel).toMatch(/disabled=\{!text\.trim\(\) \|\| sending \|\| offline\}[^>]*>\{offline \? OFFLINE_POST : 'Reply'\}/);
    expect(panel).not.toMatch(/<textarea[^>]*disabled/);
    // A draft is cleared only after the post succeeds.
    expect(panel).toMatch(/await createComment\([^;]*;\s*posted\(\);/);
    expect(panel).toMatch(/await replyTo\([^;]*;\s*posted\(\);/);
  });
});
