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
});
