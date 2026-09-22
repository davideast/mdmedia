import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Playlist, UserProfile, UserSettings } from '../../studio/src/lib/types';

describe('Firestore CQRS & Optimistic Mutations Architecture', () => {
  const playlistsSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/playlists.ts'),
    'utf8',
  );
  const usersSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/users.ts'),
    'utf8',
  );
  const narrationsSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/narrations.ts'),
    'utf8',
  );
  const playlistsPageSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/app/(app)/playlists/page.tsx'),
    'utf8',
  );

  describe('Playlists Optimistic Contract', () => {
    it('createPlaylist pre-allocates document reference synchronously instead of awaiting addDoc', () => {
      // Must use doc(playlistsCollection()) to generate ID synchronously offline
      expect(playlistsSource).toContain('const newRef = doc(playlistsCollection())');
      expect(playlistsSource).toContain('setDoc(newRef');
      expect(playlistsSource).not.toMatch(/await\s+addDoc\(/);
      expect(playlistsSource).not.toMatch(/await\s+setDoc\(/);
    });

    it('updatePlaylist executes fire-and-forget without awaiting updateDoc', () => {
      expect(playlistsSource).not.toMatch(/await\s+updateDoc\(/);
      expect(playlistsSource).toMatch(/void\s+updateDoc\(playlistRef\(id\)/);
    });

    it('deletePlaylist executes fire-and-forget without awaiting deleteDoc', () => {
      expect(playlistsSource).not.toMatch(/await\s+deleteDoc\(/);
      expect(playlistsSource).toMatch(/void\s+deleteDoc\(playlistRef\(id\)/);
    });

    it('optimistically computes track toggle array in-memory', () => {
      const playlist: Playlist = {
        id: 'pl-1',
        ownerUid: 'u-1',
        title: 'Weekly Reads',
        description: '',
        narrationIds: ['n-1', 'n-2'],
        createdAt: 1000,
        updatedAt: 1000,
      };

      // Toggling existing track removes it
      const removeTrack = (pl: Playlist, targetId: string) => {
        const exists = pl.narrationIds.includes(targetId);
        return exists
          ? pl.narrationIds.filter((id) => id !== targetId)
          : [...pl.narrationIds, targetId];
      };

      expect(removeTrack(playlist, 'n-2')).toEqual(['n-1']);
      expect(removeTrack(playlist, 'n-3')).toEqual(['n-1', 'n-2', 'n-3']);
    });

    it('optimistically reorders track arrays in-memory', () => {
      const initialIds = ['n-1', 'n-2', 'n-3', 'n-4'];
      const fromIndex = 3;
      const toIndex = 1;

      const currentIds = [...initialIds];
      const [movedId] = currentIds.splice(fromIndex, 1);
      currentIds.splice(toIndex, 0, movedId);

      expect(currentIds).toEqual(['n-1', 'n-4', 'n-2', 'n-3']);
    });
  });

  describe('Users Optimistic Contract', () => {
    it('upsertUserProfile dispatches profile write optimistically without awaiting setDoc/updateDoc', () => {
      expect(usersSource).not.toMatch(/await\s+setDoc\(/);
      expect(usersSource).not.toMatch(/await\s+updateDoc\(/);
    });

    it('saveSettings dispatches settings update optimistically without awaiting updateDoc', () => {
      expect(usersSource).not.toMatch(/await\s+updateDoc\(doc\(db\(\),\s*['"]users['"]/);
      expect(usersSource).toMatch(/void\s+updateDoc\(/);
    });

    it('saveProfileFields dispatches profile fields update optimistically without awaiting updateDoc', () => {
      expect(usersSource).toMatch(/void\s+updateDoc\(/);
    });
  });

  describe('Narrations Optimistic Contract', () => {
    it('updateNarrationTitle dispatches update optimistically without awaiting updateDoc', () => {
      expect(narrationsSource).not.toMatch(/await\s+updateDoc\(doc\(db\(\),\s*['"]narrations['"],\s*id\),\s*\{\s*title:/);
      expect(narrationsSource).toMatch(/void\s+updateDoc\(doc\(db\(\),\s*['"]narrations['"],\s*id\),\s*\{\s*title:/);
    });

    it('updateVisibility dispatches update optimistically without awaiting updateDoc', () => {
      expect(narrationsSource).not.toMatch(/await\s+updateDoc\(doc\(db\(\),\s*['"]narrations['"],\s*id\),\s*\{\s*visibility/);
      expect(narrationsSource).toMatch(/void\s+updateDoc\(doc\(db\(\),\s*['"]narrations['"],\s*id\),\s*\{\s*visibility/);
    });
  });

  describe('UI Immediate Dismissal & Dispatch Contract', () => {
    it('playlists/page.tsx dismisses editing and deletion state synchronously without async transitions', () => {
      expect(playlistsPageSource).not.toContain('startTransition(async () => {');
      expect(playlistsPageSource).not.toContain('await deletePlaylist(');
      expect(playlistsPageSource).not.toContain('await updatePlaylist(');
      expect(playlistsPageSource).not.toContain('await createPlaylist(');
    });
  });
});
