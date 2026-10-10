import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { readMp4Duration } from 'mdmedia/video';
import { adminBucket, adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import type { StoredAsset } from './assets-server';
import { MAX_VIDEO_BYTES } from './video-request';
const execute = promisify(execFile);
const globalTransforms = globalThis as typeof globalThis & { __mdmediaClipTransforms?: Map<string, Promise<Buffer>> };
const transforms = globalTransforms.__mdmediaClipTransforms ??= new Map();
let preflight: Promise<boolean> | undefined;
export function videoToolsAvailable(): Promise<boolean> {
  return preflight ??= (ffmpeg ? execute(ffmpeg, ['-version'], { timeout: 10_000, maxBuffer: 64_000 }).then(() => true, () => false) : Promise.resolve(false));
}
async function transform(bytes: Uint8Array, args: string[], output: string): Promise<Buffer> {
  if (!await videoToolsAvailable() || !ffmpeg) throw new MediaError(503, 'video_tools_unavailable', 'Video processing is unavailable on this Studio.');
  const directory = await mkdtemp(join(tmpdir(), 'mdmedia-video-'));
  try {
    await writeFile(join(directory, 'input.mp4'), bytes);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-i', join(directory, 'input.mp4'), ...args, join(directory, output)], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const result = await readFile(join(directory, output));
    if (result.length > MAX_VIDEO_BYTES) throw new MediaError(502, 'output_too_large', 'The returned video is too large.');
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function saveVideoAsset(uid: string, bytes: Uint8Array, generationId: string, itemId: string): Promise<StoredAsset> {
  const durationSeconds = readMp4Duration(bytes);
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES || !durationSeconds || durationSeconds > 40.25) throw new MediaError(502, 'invalid_video', 'Gemini returned an invalid video.');
  const frame = await transform(bytes, ['-frames:v', '1'], 'poster.png');
  const metadata = await sharp(frame).metadata();
  const thumbnail = await sharp(frame).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
  const id = `video_${generationId}`;
  const path = `media/${uid}/${id}/original`; const thumbnailPath = `media/${uid}/${id}/thumbnail.webp`;
  // Storage first: deterministic paths permit recovery after either write or the DB checkpoint.
  await adminBucket().file(path).save(Buffer.from(bytes), { resumable: false, contentType: 'video/mp4' });
  await adminBucket().file(thumbnailPath).save(thumbnail, { resumable: false, contentType: 'image/webp' });
  const asset: StoredAsset = { id, ownerUid: uid, purpose: 'output', mediaType: 'video', generationId, itemId, path, thumbnailPath,
    mimeType: 'video/mp4', width: metadata.width!, height: metadata.height!, durationMs: Math.round(durationSeconds * 1000), byteLength: bytes.length, createdAt: Date.now() };
  await adminDb().collection('mediaAssets').doc(id).set(asset);
  return asset;
}
/** Extract from the selected complete version. No model invocation, no concatenation. */
export async function videoClipContent(asset: StoredAsset, index: number, start: number, end: number, thumbnail: boolean): Promise<Buffer> {
  if (!Number.isInteger(index) || index < 1 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 40.25) throw new MediaError(400, 'invalid_clip', 'Choose an available clip.');
  const path = `media/${asset.ownerUid}/${asset.id}/clips/${index}.${thumbnail ? 'webp' : 'mp4'}`;
  try { return (await adminBucket().file(path).download())[0]; } catch { /* A cache miss is a local operation. */ }
  const pending = transforms.get(path); if (pending) return pending;
  if (transforms.size >= 2) throw new MediaError(429, 'clip_processing_busy', 'Another clip is being prepared. Try again shortly.');
  const generate = async () => {
    const [source] = await adminBucket().file(asset.path).download();
    const bytes = thumbnail
      ? await sharp(await transform(source, ['-ss', String(start), '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease'], 'poster.png')).webp().toBuffer()
      : await transform(source, ['-ss', String(start), '-t', String(end - start), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart'], 'clip.mp4');
    await adminBucket().file(path).save(bytes, { resumable: false, contentType: thumbnail ? 'image/webp' : 'video/mp4' });
    return bytes;
  };
  const operation = generate(); transforms.set(path, operation);
  try { return await operation; } finally { transforms.delete(path); }
}
