import sharp from 'sharp';
import { adminBucket, adminDb } from './firebase-admin';
import { MAX_REFERENCE_BYTES, MediaError, validMediaId } from './image-request';
import type { AssetResource } from './media-types';

export interface StoredAsset {
  id: string; ownerUid: string; purpose: 'reference' | 'output';
  generationId: string | null; itemId: string | null; mediaType?: 'image' | 'video' | 'music' | 'sfx'; durationMs?: number;
  path: string; thumbnailPath: string; mimeType: string;
  width: number; height: number; byteLength: number; createdAt: number;
}
export async function inspectImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new MediaError(400, 'invalid_image', 'The image is empty or too large.');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const metadata = await image.metadata();
    const mimeType = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[metadata.format ?? ''];
    if (!mimeType || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
    // Decode once: headers alone do not establish a valid reference image.
    const thumbnail = await image.rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
    return { mimeType, width: metadata.width, height: metadata.height, thumbnail };
  } catch { throw new MediaError(400, 'invalid_image', 'Use a valid still PNG, JPEG, or WebP image.'); }
}
export async function saveImageAsset(uid: string, bytes: Uint8Array, purpose: StoredAsset['purpose'], generationId: string | null = null, itemId: string | null = null, mediaType: 'image' | 'video' | 'music' = 'image'): Promise<StoredAsset> {
  if (purpose === 'reference' && bytes.length > MAX_REFERENCE_BYTES) throw new MediaError(413, 'reference_too_large', 'Reference images must be at most 10 MiB.');
  const info = await inspectImage(bytes);
  // A deterministic output ID makes recovery finish storage rather than generate again.
  const id = generationId ? `image_${generationId}` : adminDb().collection('mediaAssets').doc().id;
  const path = `media/${uid}/${id}/original`;
  const thumbnailPath = `media/${uid}/${id}/thumbnail.webp`;
  await Promise.all([
    adminBucket().file(path).save(Buffer.from(bytes), { resumable: false, contentType: info.mimeType }),
    adminBucket().file(thumbnailPath).save(info.thumbnail, { resumable: false, contentType: 'image/webp' }),
  ]);
  const asset: StoredAsset = { id, ownerUid: uid, purpose, generationId, itemId, mediaType, path, thumbnailPath,
    mimeType: info.mimeType, width: info.width, height: info.height, byteLength: bytes.length, createdAt: Date.now() };
  await adminDb().collection('mediaAssets').doc(id).set(asset);
  return asset;
}
export async function loadOwnedAsset(uid: string, id: string): Promise<StoredAsset> {
  if (!validMediaId(id)) {
    throw new MediaError(404, 'not_found', 'That asset is not available to you.');
  }
  const direct = await adminDb().collection('mediaAssets').doc(id).get();
  const directAsset = direct.data() as StoredAsset | undefined;
  if (directAsset && directAsset.ownerUid === uid) {
    return directAsset;
  }

  for (const prefix of ['image_', 'video_', 'music_', 'sfx_']) {
    if (!id.startsWith(prefix)) {
      const prefixed = await adminDb().collection('mediaAssets').doc(`${prefix}${id}`).get();
      const prefixedAsset = prefixed.data() as StoredAsset | undefined;
      if (prefixedAsset && prefixedAsset.ownerUid === uid) {
        return prefixedAsset;
      }
    }
  }

  const genSnap = await adminDb().collection('mediaGenerations').doc(id).get();
  const genData = genSnap.data() as { ownerUid?: string; assetId?: string | null } | undefined;
  if (genData && genData.ownerUid === uid && genData.assetId) {
    const fromGen = await adminDb().collection('mediaAssets').doc(genData.assetId).get();
    const fromGenAsset = fromGen.data() as StoredAsset | undefined;
    if (fromGenAsset && fromGenAsset.ownerUid === uid) {
      return fromGenAsset;
    }
  }

  for (const prefix of ['image_', 'video_', 'music_', 'sfx_']) {
    const itemId = id.startsWith(prefix) ? id : `${prefix}${id}`;
    const itemSnap = await adminDb().collection('mediaItems').doc(itemId).get();
    const itemData = itemSnap.data() as {
      ownerUid?: string;
      thumbnailAssetId?: string | null;
      latestSuccessfulGenerationId?: string | null;
      latestGenerationId?: string | null;
    } | undefined;
    if (itemData && itemData.ownerUid === uid) {
      const candidateGenId = itemData.latestSuccessfulGenerationId ?? itemData.latestGenerationId;
      if (candidateGenId) {
        const candidateAssetSnap = await adminDb().collection('mediaAssets').doc(`${prefix}${candidateGenId}`).get();
        const candidateAsset = candidateAssetSnap.data() as StoredAsset | undefined;
        if (candidateAsset && candidateAsset.ownerUid === uid) {
          return candidateAsset;
        }
      }
      if (itemData.thumbnailAssetId) {
        const thumbSnap = await adminDb().collection('mediaAssets').doc(itemData.thumbnailAssetId).get();
        const thumbAsset = thumbSnap.data() as StoredAsset | undefined;
        if (thumbAsset && thumbAsset.ownerUid === uid) {
          return thumbAsset;
        }
      }
    }
  }

  throw new MediaError(404, 'not_found', 'That asset is not available to you.');
}
export function assetResource(asset: StoredAsset, origin: string): AssetResource {
  return { id: asset.id, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.byteLength, ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
    links: { content: `${origin}/api/v1/assets/${asset.id}/content`, thumbnail: `${origin}/api/v1/assets/${asset.id}/content?thumbnail=1` } };
}
