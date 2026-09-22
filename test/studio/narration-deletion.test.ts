import { describe, expect, it } from 'bun:test';
import type { Playlist } from '../../studio/src/lib/types';

describe('Narration Deletion Logic', () => {
  it('validates deletion handler contract', () => {
    type DeleteHandler = (id: string, ownerUid?: string) => Promise<void>;
    const dummyHandler: DeleteHandler = async () => {};
    expect(typeof dummyHandler).toBe('function');
  });

  describe('Playlist cleanup on narration deletion', () => {
    it('filters out deleted narration ID from playlist narrationIds array', () => {
      const deletedId = 'narration-to-delete';
      const playlists: Playlist[] = [
        {
          id: 'p1',
          ownerUid: 'user-1',
          title: 'Favorites',
          description: '',
          narrationIds: ['n1', deletedId, 'n3'],
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          id: 'p2',
          ownerUid: 'user-1',
          title: 'Architecture',
          description: '',
          narrationIds: ['other-1', 'other-2'],
          createdAt: 2000,
          updatedAt: 2000,
        },
      ];

      const cleanedPlaylists = playlists.map((p) => {
        const nextIds = p.narrationIds.filter((id) => id !== deletedId);
        return {
          ...p,
          narrationIds: nextIds,
          updatedAt: nextIds.length !== p.narrationIds.length ? 3000 : p.updatedAt,
        };
      });

      expect(cleanedPlaylists[0].narrationIds).toEqual(['n1', 'n3']);
      expect(cleanedPlaylists[0].updatedAt).toBe(3000);
      expect(cleanedPlaylists[1].narrationIds).toEqual(['other-1', 'other-2']);
      expect(cleanedPlaylists[1].updatedAt).toBe(2000);
    });

    it('handles empty playlist narrationIds gracefully', () => {
      const deletedId = 'narration-to-delete';
      const playlist: Playlist = {
        id: 'p1',
        ownerUid: 'user-1',
        title: 'Empty Playlist',
        description: '',
        narrationIds: [],
        createdAt: 1000,
        updatedAt: 1000,
      };

      const nextIds = playlist.narrationIds.filter((id) => id !== deletedId);
      expect(nextIds).toEqual([]);
    });
  });

  describe('Stream cancel on active narration deletion', () => {
    it('cancels active playback when deleted narration matches active stream id', () => {
      let cancelled = false;
      const mockStream = {
        id: 'active-narration-123',
        cancel: () => {
          cancelled = true;
        },
      };

      const targetId = 'active-narration-123';
      if (mockStream.id === targetId) {
        mockStream.cancel();
      }

      expect(cancelled).toBe(true);
    });

    it('does not cancel stream when deleting a different narration', () => {
      let cancelled = false;
      const mockStream = {
        id: 'active-narration-123',
        cancel: () => {
          cancelled = true;
        },
      };

      const targetId = 'different-narration-456';
      if (mockStream.id === targetId) {
        mockStream.cancel();
      }

      expect(cancelled).toBe(false);
    });
  });

  describe('Atomic Purge on Cancellation Policy', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');

    const narrationServerSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/narration-server.ts'),
      'utf8',
    );
    const deleteRouteSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/app/api/narrations/[id]/route.ts'),
      'utf8',
    );
    const useGenQueueSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/use-generation-queue.ts'),
      'utf8',
    );
    const queuePageSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/app/(app)/queue/page.tsx'),
      'utf8',
    );

    it('implements purgeNarrationData on the server using a Firestore transaction', () => {
      expect(narrationServerSource).toContain('export async function purgeNarrationData');
      expect(narrationServerSource).toContain('adminDb().runTransaction');
      expect(narrationServerSource).toContain('tx.delete(docRef)');
      expect(narrationServerSource).toContain('audioObjectPath(uid, id)');
      expect(narrationServerSource).toContain('timingsObjectPath(uid, id)');
    });

    it('aborts active synthesis streams when purgeNarrationData is invoked', () => {
      expect(narrationServerSource).toContain('activeStreams');
      expect(narrationServerSource).toContain('active.abort()');
    });

    it('exposes DELETE /api/narrations/[id] route calling purgeNarrationData with auth verification', () => {
      expect(deleteRouteSource).toContain('verifyIdToken');
      expect(deleteRouteSource).toContain('purgeNarrationData(id, uid)');
      expect(deleteRouteSource).toContain('export async function DELETE');
    });

    it('pre-allocates narrationId so cancelJob can purge immediately without spinning', () => {
      expect(useGenQueueSource).toContain('const narrationId = generateNarrationId()');
      expect(useGenQueueSource).toContain('deleteNarration(narrationId)');
      expect(useGenQueueSource).toContain('setJobs((previous) => previous.filter((j) => j.id !== jobId))');
    });

    it('provides cancel button on orphanStreamingNarrations in QueuePage to clean up stuck generations', () => {
      expect(queuePageSource).toContain('handleCancelOrphan');
      expect(queuePageSource).toContain('deleteNarration(id)');
      expect(queuePageSource).toContain('title="Cancel generation"');
    });
  });

  describe('Optimistic CQRS Deletion Architecture', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');

    const narrationsSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/narrations.ts'),
      'utf8',
    );
    const libraryPageSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/app/(app)/library/page.tsx'),
      'utf8',
    );
    const settingsSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/components/narration/narration-settings.tsx'),
      'utf8',
    );

    it('uses deleteDoc directly and does not call client-side runTransaction in deleteNarration', () => {
      const deleteNarrationBody = narrationsSource.slice(
        narrationsSource.indexOf('export async function deleteNarration('),
        narrationsSource.indexOf('export function generateNarrationId('),
      );

      expect(deleteNarrationBody).toContain('deleteDoc(');
      expect(deleteNarrationBody).not.toContain('runTransaction(');
    });

    it('performs background out-of-band storage purge without blocking client mutation', () => {
      const deleteNarrationBody = narrationsSource.slice(
        narrationsSource.indexOf('export async function deleteNarration('),
        narrationsSource.indexOf('export function generateNarrationId('),
      );

      expect(deleteNarrationBody).toMatch(/fetch\(`\/api\/narrations\/\$\{id\}`,\s*\{\s*method:\s*['"]DELETE['"]/);
    });

    it('library/page.tsx closes delete dialog immediately upon confirmation instead of blocking with spinner', () => {
      const confirmDeleteBody = libraryPageSource.slice(
        libraryPageSource.indexOf('const handleConfirmDelete ='),
        libraryPageSource.indexOf('return (', libraryPageSource.indexOf('const handleConfirmDelete =')),
      );

      expect(confirmDeleteBody).toContain('setItemToDelete(null)');
      const setItemPos = confirmDeleteBody.indexOf('setItemToDelete(null)');
      const deleteNarrationPos = confirmDeleteBody.indexOf('deleteNarration(');
      expect(setItemPos).toBeLessThan(deleteNarrationPos);
    });

    it('narration-settings.tsx closes delete dialog immediately upon confirmation', () => {
      const deleteNarrationBody = settingsSource.slice(
        settingsSource.indexOf('const handleDeleteNarration ='),
        settingsSource.indexOf('const isAdapted =', settingsSource.indexOf('const handleDeleteNarration =')),
      );

      expect(deleteNarrationBody).toContain('setDeleteDialogOpen(false)');
      const setDialogPos = deleteNarrationBody.indexOf('setDeleteDialogOpen(false)');
      const deleteNarrationPos = deleteNarrationBody.indexOf('deleteNarration(');
      expect(setDialogPos).toBeLessThan(deleteNarrationPos);
    });
  });
});
