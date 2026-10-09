import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyPlaylistOps,
  checkReorder,
  parsePlaylistOps,
  PlaylistOpError,
} from '../../studio/src/lib/playlist-ops';
import { resolveNarrationBody } from '../../studio/src/lib/narration-api';
import { DEFAULT_SETTINGS, MAX_PLAYLIST_ITEMS } from '../../studio/src/lib/types';

const codeOf = (run: () => unknown) => {
  try { run(); } catch (error) { return (error as PlaylistOpError).code; }
  return null;
};

describe('playlist edits', () => {
  it('add at a position named by a neighbour, and skip items already there', () => {
    const result = applyPlaylistOps(['a', 'b', 'c'], [{ add: ['x', 'b'], at: { after: 'a' } }]);
    expect(result.narrationIds).toEqual(['a', 'x', 'b', 'c']);
    expect(result.unchanged).toEqual(['b']);
    expect(applyPlaylistOps(['a'], [{ add: ['x'], at: 'start' }]).narrationIds).toEqual(['x', 'a']);
    expect(applyPlaylistOps(['a'], [{ add: ['x'] }]).narrationIds).toEqual(['a', 'x']);
  });

  it('apply to what the playlist holds now, so a concurrent add survives a move', () => {
    // The app moved "c" to the start while an agent had appended "z".
    const now = ['a', 'b', 'c', 'z'];
    expect(applyPlaylistOps(now, [{ move: 'c', to: 'start' }]).narrationIds).toEqual(['c', 'a', 'b', 'z']);
  });

  it('remove, and report removes of items that are not there', () => {
    const result = applyPlaylistOps(['a', 'b'], [{ remove: ['a', 'q'] }]);
    expect(result.narrationIds).toEqual(['b']);
    expect(result.unchanged).toEqual(['q']);
  });

  it('move before and after other items', () => {
    expect(applyPlaylistOps(['a', 'b', 'c'], [{ move: 'a', to: { after: 'c' } }]).narrationIds).toEqual(['b', 'c', 'a']);
    expect(applyPlaylistOps(['a', 'b', 'c'], [{ move: 'c', to: { before: 'b' } }]).narrationIds).toEqual(['a', 'c', 'b']);
    expect(applyPlaylistOps(['a', 'b'], [{ move: 'a', to: { after: 'a' } }]).narrationIds).toEqual(['a', 'b']);
  });

  it('apply a batch in order', () => {
    const result = applyPlaylistOps(['a', 'b', 'c'], [
      { add: ['d'] },
      { remove: ['b'] },
      { move: 'd', to: 'start' },
    ]);
    expect(result.narrationIds).toEqual(['d', 'a', 'c']);
  });

  it('refuse rather than truncate or guess', () => {
    expect(codeOf(() => applyPlaylistOps(['a'], [{ add: ['x'], at: { before: 'nope' } }]))).toBe('anchor_not_found');
    expect(codeOf(() => applyPlaylistOps(['a'], [{ move: 'nope', to: 'start' }]))).toBe('not_in_playlist');
    const full = Array.from({ length: MAX_PLAYLIST_ITEMS }, (_, index) => `n${index}`);
    expect(codeOf(() => applyPlaylistOps(full, [{ add: ['extra'] }]))).toBe('playlist_full');
  });

  it('accept a full reorder only of exactly the items already there', () => {
    expect(() => checkReorder(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(codeOf(() => checkReorder(['a', 'b', 'z'], ['b', 'a']))).toBe('invalid_order');
    expect(codeOf(() => checkReorder(['a', 'b'], ['b', 'a', 'a']))).toBe('invalid_order');
  });

  it('validate edits from a request body', () => {
    expect(parsePlaylistOps([{ add: ['a'], at: { after: 'b' } }, { remove: ['c'] }, { move: 'a', to: 'end' }])).toHaveLength(3);
    expect(parsePlaylistOps([])).toContain('non-empty');
    expect(parsePlaylistOps([{ add: [] }])).toContain('ops[0].add');
    expect(parsePlaylistOps([{ move: 'a', to: 3 }])).toContain('ops[0].to');
    expect(parsePlaylistOps([{ rename: 'x' }])).toContain('add, remove, or move');
  });
});

describe('narrate into a playlist', () => {
  const resolve = (body: Record<string, unknown>) => resolveNarrationBody({ markdown: 'Hello there.', ...body }, DEFAULT_SETTINGS, { restricted: true });

  it('carries the placement next to the narration request', () => {
    const result = resolve({ playlist: ' Commute ', playlistPosition: { after: 'abc' } });
    expect(result.ok && result.placement).toEqual({ playlist: 'Commute', position: { after: 'abc' }, create: false });
    const plain = resolve({});
    expect(plain.ok && plain.placement).toBeNull();
  });

  it('rejects a position or create flag without a playlist, and bad positions', () => {
    expect(resolve({ playlistPosition: 'start' })).toMatchObject({ ok: false, code: 'missing_playlist' });
    expect(resolve({ playlist: 'Commute', playlistPosition: 2 })).toMatchObject({ ok: false, code: 'invalid_playlist_position' });
  });
});

describe('the app edits playlists without overwriting agent edits', () => {
  const source = readFileSync(new URL('../../studio/src/lib/playlists.ts', import.meta.url), 'utf8');

  it('adds and removes with atomic array changes and moves in a transaction', () => {
    expect(source).toContain('arrayUnion(narrationId)');
    expect(source).toContain('arrayRemove(narrationId)');
    expect(source).toContain('runTransaction(db()');
    expect(source).not.toMatch(/narrationIds\?: string\[\]/);
  });
});
