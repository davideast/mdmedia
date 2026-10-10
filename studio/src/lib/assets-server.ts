import sharp from 'sharp';
import { adminBucket, adminDb } from './firebase-admin';
import { MAX_REFERENCE_BYTES, MediaError, validMediaId } from './image-request';
import type { AssetResource } from './media-types';

export interface StoredAsset {
  id: string; ownerUid: string; purpose: 'reference' | 'output';
  generationId: string | null; itemId: string | null;
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
export async function saveImageAsset(uid: string, bytes: Uint8Array, purpose: StoredAsset['purpose'], generationId: string | null = null, itemId: string | null = null): Promise<StoredAsset> {
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
  const asset: StoredAsset = { id, ownerUid: uid, purpose, generationId, itemId, path, thumbnailPath,
    mimeType: info.mimeType, width: info.width, height: info.height, byteLength: bytes.length, createdAt: Date.now() };
  await adminDb().collection('mediaAssets').doc(id).set(asset);
  return asset;
}
export async function loadOwnedAsset(uid: string, id: string): Promise<StoredAsset> {
  const snapshot = validMediaId(id) ? await adminDb().collection('mediaAssets').doc(id).get() : null;
  const asset = snapshot?.data() as StoredAsset | undefined;
  if (!asset || asset.ownerUid !== uid) throw new MediaError(404, 'not_found', 'That asset is not available to you.');
  return asset;
}
export function assetResource(asset: StoredAsset, origin: string): AssetResource {
  return { id: asset.id, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.byteLength,
    links: { content: `${origin}/api/v1/assets/${asset.id}/content`, thumbnail: `${origin}/api/v1/assets/${asset.id}/content?thumbnail=1` } };
}
