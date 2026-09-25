import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Narration ID Ownership & Stream Guarding', () => {
  const routeSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/app/api/narrations/route.ts'),
    'utf8',
  );
  const serverSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/narration-server.ts'),
    'utf8',
  );

  it('route.ts calls claimNarrationId before creating a narration stream and returns 409', () => {
    const claimAt = routeSource.indexOf('if (!(await claimNarrationId(id, uid)))');
    const streamAt = routeSource.indexOf('createNarrationStream({');
    expect(claimAt).toBeGreaterThan(-1);
    expect(streamAt).toBeGreaterThan(claimAt);
    expect(routeSource).toContain('status: 409');
  });

  it('route.ts maps a foreign live-stream NarrationOwnershipError to 409, not 500', () => {
    expect(routeSource).toContain('if (error instanceof NarrationOwnershipError) return conflict();');
    expect(serverSource).toContain('export class NarrationOwnershipError extends Error');
    expect(serverSource).not.toContain('throw new Error("Forbidden: narration id belongs to another user.")');
  });

  it('narration-server.ts exports claimNarrationId checking doc existence and ownerUid', () => {
    expect(serverSource).toContain(
      'export async function claimNarrationId(id: string, uid: string): Promise<boolean>',
    );
    expect(serverSource).toContain('snap.data()?.ownerUid === uid');
  });

  it('narration-server.ts has no bare docRef.set(initialNarration) and uses transactional ownership verification', () => {
    expect(serverSource).not.toContain('await docRef.set(initialNarration);');
    expect(serverSource).toContain('owner !== uid');
    expect(serverSource).toContain('tx.set(docRef, initialNarration)');
  });

  it('narration-server.ts guards activeStreams against replacement by a different user', () => {
    expect(serverSource).toContain('existingStream.uid !== uid');
    expect(serverSource).toContain('activeStreams.set(id, { uid, abort: abortStream });');
  });
});
