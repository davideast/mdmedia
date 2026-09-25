import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Server Storage Path Derivation', () => {
  const audioRouteSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/app/api/narrations/[id]/audio/route.ts'),
    'utf8',
  );
  const timingsRouteSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/app/api/narrations/[id]/timings/route.ts'),
    'utf8',
  );

  it('audio route derives objectPath strictly via audioObjectPath(narration.ownerUid, id)', () => {
    expect(audioRouteSource).toContain('audioObjectPath(');
    expect(audioRouteSource).toContain(
      'const objectPath = audioObjectPath(narration.ownerUid, id);',
    );
    expect(audioRouteSource).not.toContain('narration.audioPath ||');
  });

  it('timings route derives objectPath strictly via timingsObjectPath(narration.ownerUid, id)', () => {
    expect(timingsRouteSource).toContain('timingsObjectPath(');
    expect(timingsRouteSource).toContain(
      'const objectPath = timingsObjectPath(narration.ownerUid, id);',
    );
    expect(timingsRouteSource).not.toContain('narration.timingsPath ||');
  });

  describe('public playback without an allowlisted identity (plans 003 + 005)', () => {
    const serverSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/narration-server.ts'),
      'utf8',
    );
    const hookSource = readFileSync(
      resolve(import.meta.dir, '../../studio/src/lib/use-narration-stream.ts'),
      'utf8',
    );

    it('routes only return 401 after the narration lookup fails for a null uid', () => {
      for (const src of [audioRouteSource, timingsRouteSource]) {
        const lookupAt = src.indexOf('await loadReadableNarration(id, uid)');
        const unauthAt = src.indexOf('if (!narration && !uid)');
        expect(lookupAt).toBeGreaterThan(-1);
        expect(unauthAt).toBeGreaterThan(lookupAt);
        expect(src).not.toContain('if (!uid) {');
      }
    });

    it('loadReadableNarration serves public to anyone and gates owner/shared on a non-null uid', () => {
      const fn = serverSource.slice(serverSource.indexOf('export async function loadReadableNarration('));
      expect(fn).toContain('uid: string | null');
      const publicAt = fn.indexOf('if (narration.visibility === "public") return narration;');
      const nullAt = fn.indexOf('if (uid === null) return null;');
      expect(publicAt).toBeGreaterThan(-1);
      expect(nullAt).toBeGreaterThan(publicAt);
    });

    it('client playback does not bail out when there is no ID token', () => {
      expect(hookSource).toContain("token ? { Authorization: `Bearer ${token}` } : {}");
    });
  });
});
