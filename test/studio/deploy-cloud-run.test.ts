import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toNarration } from '../../studio/src/lib/narrations';

describe('Plan 007 — Cloud Run CORS, stale streaming recovery & UID share labels', () => {
  const routeSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/app/api/narrations/route.ts'),
    'utf8',
  );
  const serverSource = readFileSync(
    resolve(import.meta.dir, '../../studio/src/lib/narration-server.ts'),
    'utf8',
  );

  it('echoes Access-Control-Allow-Origin only for origins listed in ALLOWED_WEB_ORIGINS', () => {
    expect(routeSource).toContain('export async function OPTIONS');
    expect(routeSource).toContain('ALLOWED_WEB_ORIGINS');
    expect(routeSource).toContain('"Access-Control-Allow-Origin": origin');
    expect(routeSource).toContain('Vary: "Origin"');
    expect(routeSource).not.toContain('"Access-Control-Allow-Origin": "*"');
    expect(routeSource).toContain('status: 204');
  });

  it('transitions stale streaming narrations older than STALE_STREAMING_MS to errorCode="interrupted"', () => {
    expect(serverSource).toContain('export const STALE_STREAMING_MS = 15 * 60 * 1000;');
    expect(serverSource).toContain('export async function markStaleStreaming(');
    expect(serverSource).toContain('narration.status !== "streaming"');
    expect(serverSource).toContain('STALE_STREAMING_MS');
    expect(serverSource).toContain('status: "error"');
    expect(serverSource).toContain('errorCode: "interrupted"');
  });

  it('parses sharedWithLabels alongside sharedWith in toNarration', () => {
    const parsed = toNarration({
      id: 'shared-1',
      data: () => ({
        ownerUid: 'alice-uid',
        title: 'Shared Doc',
        visibility: 'shared',
        sharedWith: ['bob-uid'],
        sharedWithLabels: { 'bob-uid': 'bob@example.test', invalid: 123 },
      }),
    });
    expect(parsed.sharedWith).toEqual(['bob-uid']);
    expect(parsed.sharedWithLabels).toEqual({ 'bob-uid': 'bob@example.test' });
  });
});
