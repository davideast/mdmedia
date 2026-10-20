import { Readable } from 'node:stream';
import { authenticate, hasScope, forbiddenScope, unauthorized } from '@/lib/api-auth';
import { loadOwnedAsset, type StoredAsset } from '@/lib/assets-server';
import { parseByteRange } from '@/lib/byte-range';
import { adminBucket, adminDb } from '@/lib/firebase-admin';
import { MediaError, validMediaId } from '@/lib/image-request';
import { mediaApi } from '@/lib/media-api-server';
import { assetReadScope, mediaLinkSecret, presentedLink, verifyMediaLink } from '@/lib/media-links';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const extension = (mimeType: string) => (mimeType === 'audio/mpeg' ? 'mp3' : mimeType === 'video/quicktime' ? 'mov' : mimeType.split('/')[1]);

const refused = (expired: boolean) => expired
  ? new MediaError(403, 'link_expired', 'This media link has expired. Ask for a new one.')
  : new MediaError(403, 'invalid_link', 'This media link is not valid.');

/**
 * The asset a signed link opens, and the seconds the link has left. The
 * link is checked against the asset's own owner, so it opens only the asset
 * it was made for. A missing asset reads as an invalid link.
 */
async function linkedAsset(id: string, link: { exp: number; sig: string }): Promise<{ asset: StoredAsset; remaining: number }> {
  const snapshot = validMediaId(id) ? await adminDb().collection('mediaAssets').doc(id).get() : null;
  const asset = snapshot?.exists ? snapshot.data() as StoredAsset | undefined : undefined;
  if (!asset?.ownerUid) throw refused(false);
  const check = verifyMediaLink(mediaLinkSecret(), { assetId: id, ownerUid: asset.ownerUid, exp: link.exp }, link.sig);
  if (check !== 'ok') throw refused(check === 'expired');
  return { asset, remaining: Math.max(0, Math.floor(link.exp - Date.now() / 1000)) };
}

/**
 * An asset's bytes, for its owner: with the `Authorization` header, or with
 * a signed link from `POST /api/v1/assets/links` (`?exp=…&sig=…`), which is
 * how `<video>` and `<img>` elements load private media. Images and
 * thumbnails are sent whole. Video and audio stream from Storage and honour
 * a single byte range (206, `Content-Range`, or 416 outside the file), so a
 * player can seek without fetching the whole file. Assets never change, so
 * the ETag is fixed.
 */
async function serve(request: Request, context: Context, head: boolean): Promise<Response> {
  const id = (await context.params).id;
  const query = new URL(request.url).searchParams;
  const link = request.headers.get('authorization') ? null : presentedLink(query);
  if (link === 'invalid') throw refused(false);
  let asset: StoredAsset;
  // A signed URL changes with its expiry, so its answer may be cached until then.
  let cache = 'private, max-age=60';
  if (link) {
    const linked = await linkedAsset(id, link);
    asset = linked.asset;
    cache = `private, max-age=${Math.min(linked.remaining, 3600)}`;
  } else {
    const caller = await authenticate(request); if (!caller) return unauthorized();
    asset = await loadOwnedAsset(caller.uid, id);
    const scope = assetReadScope(asset);
    if (!hasScope(caller, scope)) return forbiddenScope(scope);
  }
  const thumbnail = query.get('thumbnail') === '1';
  if (thumbnail && !asset.thumbnailPath) throw new MediaError(404, 'no_thumbnail', 'That asset has no thumbnail.');
  const mimeType = thumbnail ? 'image/webp' : asset.mimeType;
  const headers = new Headers({ 'Content-Type': mimeType, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (query.get('download') === '1') headers.set('Content-Disposition', `attachment; filename="${asset.id}.${extension(mimeType)}"`);

  if (thumbnail || mimeType.startsWith('image/')) {
    const [bytes] = await adminBucket().file(thumbnail ? asset.thumbnailPath : asset.path).download();
    return new Response(head ? null : new Uint8Array(bytes), { headers });
  }

  const file = adminBucket().file(asset.path);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? asset.byteLength);
  const etag = `"${asset.contentSha256 ? asset.contentSha256.slice(0, 32) : `${asset.id}-${size.toString(16)}`}"`;
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', etag);
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  // A stale If-Range means the bytes changed under the player: send them whole.
  const ifRange = request.headers.get('if-range');
  const range = ifRange && ifRange !== etag ? null : parseByteRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  const status = range ? 206 : 200;
  if (head || size === 0) return new Response(null, { status, headers });
  const stream = file.createReadStream(range ? { start, end } : {});
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
}

export const GET = (request: Request, context: Context) => mediaApi(() => serve(request, context, false));
export const HEAD = (request: Request, context: Context) => mediaApi(() => serve(request, context, true));
