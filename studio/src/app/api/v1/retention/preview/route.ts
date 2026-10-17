import { authorize } from '@/lib/api-auth';
import { MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { MEDIA_TYPES, type MediaType } from '@/lib/media-types';
import { setDefaultTtl } from '@/lib/retention';
import { sweepExpired } from '@/lib/retention-sweep';
export const runtime = 'nodejs';

/**
 * What the next sweep would delete from your library. Pass `target`, `ttl` and
 * optionally `retroactive=1` to see the effect of a default before saving it.
 */
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'options:read'); if (caller instanceof Response) return caller;
  const params = new URL(request.url).searchParams;
  const target = params.get('target');
  const ttl = params.get('ttl');
  const types: string[] = MEDIA_TYPES.map((entry) => entry.type);
  if ((target === null) !== (ttl === null)) throw new MediaError(400, 'invalid_preview', 'Pass both target and ttl, or neither.');
  if (target !== null && target !== 'global' && !types.includes(target)) throw new MediaError(400, 'invalid_target', `target must be "global" or one of: ${types.join(', ')}.`);
  const now = Date.now();
  let adjust;
  if (target !== null && ttl !== null) {
    try { setDefaultTtl({ global: null, byType: {} }, target as MediaType | 'global', ttl, now, false); }
    catch (error) { throw new MediaError(400, 'invalid_retention', error instanceof Error ? error.message : 'Invalid ttl.'); }
    adjust = (settings: Parameters<typeof setDefaultTtl>[0]) => setDefaultTtl(settings, target as MediaType | 'global', ttl, now, params.get('retroactive') === '1');
  }
  const report = await sweepExpired({ now, dryRun: true, uid: caller.uid, adjust });
  return mediaJson({
    checked: report.checked,
    count: report.expired.length,
    items: report.expired.map(({ type, id, title, expiresAt }) => ({ type, id, title, expiresAt })),
  });
});
