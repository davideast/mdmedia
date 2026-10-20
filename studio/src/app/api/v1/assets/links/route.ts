import { apiError, authenticate, hasScope, readJsonObject, unauthorized } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import { MediaError, validMediaId } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { assetReadScope, MAX_MEDIA_LINKS, mediaLinkExpiry, mediaLinkQuery, mediaLinkSecret } from '@/lib/media-links';
import { loadOwnedAssets } from '@/lib/production-media-server';
export const runtime = 'nodejs';

/**
 * `{ ids: [assetId, …] }` → `{ links: { [id]: { content, thumbnail } }, expiresAt }`:
 * a short-lived signed link to each asset of yours, for a `<video>` or `<img>`
 * that can't send the `Authorization` header. Each link opens only its own
 * asset (and its thumbnail) until `expiresAt` (milliseconds), 15 to 20
 * minutes away. Ids that aren't yours, or that your key can't read, are left
 * out. Ask again before `expiresAt` for fresh links.
 */
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request); if (!caller) return unauthorized();
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MEDIA_LINKS || !ids.every((id) => typeof id === 'string' && validMediaId(id))) {
    throw new MediaError(400, 'invalid_ids', `Send { ids } with 1 to ${MAX_MEDIA_LINKS} asset ids.`);
  }
  const assets = await loadOwnedAssets(caller.uid, ids as string[]);
  const readable = [...assets.values()].filter((asset) => hasScope(caller, assetReadScope(asset)));
  if (assets.size > 0 && readable.length === 0) return apiError(403, 'insufficient_scope', 'This API key cannot read these assets.');
  const exp = mediaLinkExpiry();
  const secret = mediaLinkSecret();
  const origin = apiOrigin(request);
  const links = Object.fromEntries(readable.map((asset) => {
    const content = `${origin}/api/v1/assets/${asset.id}/content?${mediaLinkQuery(secret, { assetId: asset.id, ownerUid: asset.ownerUid, exp })}`;
    return [asset.id, { content, thumbnail: asset.thumbnailPath ? `${content}&thumbnail=1` : null }];
  }));
  return mediaJson({ links, expiresAt: exp * 1000 });
});
