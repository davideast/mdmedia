/**
 * Media for productions: the takes, voice lines, music, stills and graphics a
 * cut arranges, and its rendered video. Each file is an ordinary
 * `mediaAssets` document with `purpose: 'production'`, stored once per owner
 * and content hash, so episodes that share takes share their assets.
 *
 * The asset id is derived from the owner and the SHA-256 of the bytes, so an
 * upload is idempotent: sending the same file again finds the asset that is
 * already there. Uploads stream to Storage and are bounded; the hash is
 * checked as the bytes arrive, and the asset document is written only once
 * the stored bytes are known to match it.
 */

import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { adminBucket, adminDb } from './firebase-admin';
import { inspectImage, type StoredAsset } from './assets-server';
import { MediaError } from './image-request';

/** What a production asset is, as a cut uses it. `voice` is a spoken line (the taxonomy's replacement for narration). */
export const PRODUCTION_MEDIA_TYPES = ['video', 'image', 'voice', 'music', 'sfx'] as const;
export type ProductionMediaType = (typeof PRODUCTION_MEDIA_TYPES)[number];

/** Rendered episodes run larger than single takes; this bounds one upload. */
export const MAX_PRODUCTION_MEDIA_BYTES = 256 * 1024 * 1024;
/** Images are decoded to check them and make their thumbnail, so they are held in memory, under a smaller bound. */
export const MAX_PRODUCTION_IMAGE_BYTES = 32 * 1024 * 1024;
/** The most hashes one lookup takes. */
export const MAX_LOOKUP_HASHES = 100;

const SHA256 = /^[0-9a-f]{64}$/;

/** Accepted content types, by media type. Audio is accepted for voice, music and sfx alike. */
const AUDIO = ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'];
const ACCEPTED: Record<ProductionMediaType, string[]> = {
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  voice: AUDIO,
  music: AUDIO,
  sfx: AUDIO,
};

/** A production asset as the API returns it. */
export interface ProductionAssetResource {
  id: string;
  mediaType: ProductionMediaType;
  mimeType: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  durationMs?: number;
  links: { content: string; thumbnail: string | null };
}

export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);

/** The asset id for `uid`'s file with this content hash. */
export function productionAssetId(uid: string, sha256: string): string {
  return `pm${createHash('sha256').update(`production-media\0${uid}\0${sha256}`).digest('hex').slice(0, 32)}`;
}

export function productionAssetResource(asset: StoredAsset, origin: string): ProductionAssetResource {
  const content = `${origin}/api/v1/assets/${asset.id}/content`;
  return {
    id: asset.id,
    mediaType: (PRODUCTION_MEDIA_TYPES as readonly string[]).includes(asset.mediaType ?? '') ? asset.mediaType as ProductionMediaType : 'video',
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    sha256: asset.contentSha256 ?? '',
    width: asset.width,
    height: asset.height,
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
    links: { content, thumbnail: asset.thumbnailPath ? `${content}?thumbnail=1` : null },
  };
}

/** Which of these content hashes `uid` already has as production assets, by hash. */
export async function findProductionMedia(uid: string, hashes: readonly string[]): Promise<Map<string, StoredAsset>> {
  const unique = [...new Set(hashes)];
  const snapshots = await Promise.all(unique.map((sha) => adminDb().collection('mediaAssets').doc(productionAssetId(uid, sha)).get()));
  const found = new Map<string, StoredAsset>();
  snapshots.forEach((snapshot, i) => {
    const asset = snapshot.data() as StoredAsset | undefined;
    if (snapshot.exists && asset && asset.ownerUid === uid && asset.purpose === 'production' && asset.contentSha256 === unique[i]) found.set(unique[i]!, asset);
  });
  return found;
}

/** `uid`'s assets with these ids, by id. Ids that are not theirs are left out. */
export async function loadOwnedAssets(uid: string, ids: Iterable<string>): Promise<Map<string, StoredAsset>> {
  const unique = [...new Set(ids)].filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
  const snapshots = await Promise.all(unique.map((id) => adminDb().collection('mediaAssets').doc(id).get()));
  const owned = new Map<string, StoredAsset>();
  for (const snapshot of snapshots) {
    const asset = snapshot.data() as StoredAsset | undefined;
    if (snapshot.exists && asset && asset.ownerUid === uid) owned.set(snapshot.id, asset);
  }
  return owned;
}

export interface ProductionUpload {
  sha256: string;
  mediaType: ProductionMediaType;
  mimeType: string;
  /** The declared size, when the request has a Content-Length. */
  contentLength: number | null;
  /** Probed by the client, which can read the whole file; stored as given. */
  durationMs?: number;
  width?: number;
  height?: number;
}

const bounded = (value: string | null, max: number): number | undefined => {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new MediaError(400, 'invalid_upload', 'durationMs, width and height must be non-negative numbers within range.');
  return Math.round(n);
};

/** Reads an upload's description from its path hash, query and headers. */
export function parseProductionUpload(sha256: string, url: URL, headers: Headers): ProductionUpload {
  if (!isSha256(sha256)) throw new MediaError(400, 'invalid_hash', 'Name the upload by the SHA-256 of its bytes: 64 lowercase hex characters.');
  const mediaType = url.searchParams.get('mediaType');
  if (!(PRODUCTION_MEDIA_TYPES as readonly string[]).includes(mediaType ?? '')) {
    throw new MediaError(400, 'invalid_type', `mediaType must be one of ${PRODUCTION_MEDIA_TYPES.join(', ')}.`);
  }
  const type = mediaType as ProductionMediaType;
  const mimeType = (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase().replace('audio/x-wav', 'audio/wav').replace('audio/wave', 'audio/wav');
  if (!ACCEPTED[type].includes(mimeType)) throw new MediaError(415, 'unsupported_media', `A ${type} upload must be one of ${ACCEPTED[type].join(', ')}.`);
  const declared = headers.get('content-length');
  const contentLength = declared === null ? null : Number(declared);
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) throw new MediaError(400, 'invalid_upload', 'Content-Length is not a byte count.');
  const limit = type === 'image' ? MAX_PRODUCTION_IMAGE_BYTES : MAX_PRODUCTION_MEDIA_BYTES;
  if (contentLength !== null && contentLength > limit) throw tooLarge(type);
  return {
    sha256, mediaType: type, mimeType, contentLength,
    durationMs: bounded(url.searchParams.get('durationMs'), 24 * 3600_000),
    width: bounded(url.searchParams.get('width'), 16384),
    height: bounded(url.searchParams.get('height'), 16384),
  };
}

function tooLarge(type: ProductionMediaType): MediaError {
  const mib = (type === 'image' ? MAX_PRODUCTION_IMAGE_BYTES : MAX_PRODUCTION_MEDIA_BYTES) / (1024 * 1024);
  return new MediaError(413, 'media_too_large', `A production ${type} upload is limited to ${mib} MiB.`);
}

/** Whether the first bytes look like the declared container, so a stored file is what its type says. */
export function matchesSignature(mimeType: string, head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') return ascii(4, 8) === 'ftyp';
  if (mimeType === 'video/webm') return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (mimeType === 'audio/wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (mimeType === 'audio/mpeg') return ascii(0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
  if (mimeType === 'audio/aac') return head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0;
  if (mimeType === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (mimeType === 'audio/flac') return ascii(0, 4) === 'fLaC';
  return true; // Images are decoded instead.
}

function write(sink: Writable, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => sink.write(chunk, (error) => (error ? reject(error) : resolve())));
}

function finish(sink: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.once('error', reject);
    sink.end(() => resolve());
  });
}

/**
 * Stores an upload as `uid`'s production asset, or returns the asset that is
 * already there for these bytes (`created: false`, the body unread).
 *
 * Video and audio stream straight to Storage, never held whole in memory.
 * Images are bounded smaller and decoded, which checks them and makes their
 * thumbnail. A body whose hash or size differs from what was declared is
 * refused and its bytes removed.
 */
export async function saveProductionMedia(uid: string, upload: ProductionUpload, body: ReadableStream<Uint8Array> | null): Promise<{ asset: StoredAsset; created: boolean }> {
  const id = productionAssetId(uid, upload.sha256);
  const ref = adminDb().collection('mediaAssets').doc(id);
  const existing = (await ref.get()).data() as StoredAsset | undefined;
  if (existing && existing.ownerUid === uid && existing.contentSha256 === upload.sha256) {
    await body?.cancel().catch(() => {});
    return { asset: existing, created: false };
  }
  if (!body) throw new MediaError(400, 'missing_body', 'Send the file as the request body.');

  const limit = upload.mediaType === 'image' ? MAX_PRODUCTION_IMAGE_BYTES : MAX_PRODUCTION_MEDIA_BYTES;
  const path = `media/${uid}/${id}/original`;
  const file = adminBucket().file(path);
  const hash = createHash('sha256');
  const reader = body.getReader();
  let size = 0;
  let head = new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  // Images are decoded from memory; everything else streams to Storage as it arrives.
  const sink = upload.mediaType === 'image' ? null : file.createWriteStream({ resumable: false, contentType: upload.mimeType });
  let stored = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.length;
      if (size > limit) throw tooLarge(upload.mediaType);
      if (head.length < 16) {
        const joined = new Uint8Array(Math.min(16, head.length + chunk.length));
        joined.set(head);
        joined.set(chunk.subarray(0, joined.length - head.length), head.length);
        head = joined;
        if (head.length >= 12 && !matchesSignature(upload.mimeType, head)) {
          throw new MediaError(415, 'unsupported_media', `The bytes are not ${upload.mimeType}.`);
        }
      }
      hash.update(chunk);
      if (sink) await write(sink, chunk);
      else chunks.push(chunk);
    }
    if (size === 0) throw new MediaError(400, 'missing_body', 'The file is empty.');
    if (upload.contentLength !== null && size !== upload.contentLength) throw new MediaError(400, 'incomplete_upload', 'The body is not as long as its Content-Length.');
    if (head.length < 12 && !matchesSignature(upload.mimeType, head)) throw new MediaError(415, 'unsupported_media', `The bytes are not ${upload.mimeType}.`);
    const digest = hash.digest('hex');
    if (digest !== upload.sha256) throw new MediaError(400, 'hash_mismatch', 'The bytes do not match the SHA-256 in the path.');

    let width = upload.width ?? 0;
    let height = upload.height ?? 0;
    let thumbnailPath = '';
    if (sink) {
      await finish(sink);
      stored = true;
    } else {
      const bytes = Buffer.concat(chunks);
      const image = await inspectImage(new Uint8Array(bytes));
      if (image.mimeType !== upload.mimeType) throw new MediaError(415, 'unsupported_media', `The bytes are ${image.mimeType}, not ${upload.mimeType}.`);
      width = image.width;
      height = image.height;
      thumbnailPath = `media/${uid}/${id}/thumbnail.webp`;
      stored = true;
      await Promise.all([
        file.save(bytes, { resumable: false, contentType: upload.mimeType }),
        adminBucket().file(thumbnailPath).save(image.thumbnail, { resumable: false, contentType: 'image/webp' }),
      ]);
    }
    const asset: StoredAsset = {
      id, ownerUid: uid, purpose: 'production', generationId: null, itemId: null, mediaType: upload.mediaType,
      path, thumbnailPath, mimeType: upload.mimeType, width, height, byteLength: size, createdAt: Date.now(),
      contentSha256: digest, ...(upload.durationMs === undefined ? {} : { durationMs: upload.durationMs }),
    };
    await ref.set(asset);
    return { asset, created: true };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (sink && !stored) sink.destroy();
    // Bytes that were committed but not accepted must not stay where the asset id points.
    if (stored) await file.delete({ ignoreNotFound: true }).catch(() => {});
    throw error;
  }
}
