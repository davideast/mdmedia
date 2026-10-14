import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';
import { adminBucket, adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import type { StoredAsset } from './assets-server';
import { MAX_SFX_BYTES } from './sfx-request';
const execute = promisify(execFile);
export interface SfxAsset extends StoredAsset { waveform: number[] }
export const sfxOriginalPath = (uid: string, generationId: string) => `media/${uid}/sfx_${generationId}/original`;
const mimeTypeFor = (format: 'mp3' | 'wav') => format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
const invalid = () => new MediaError(502, 'invalid_sfx', 'ElevenLabs returned audio that could not be decoded. Your previous sound effect is preserved.');
/** Keep paid audio before decoding it: ElevenLabs has no receipt, so recovery finishes a failed decode from this copy. */
export async function storeSfxOriginal(uid: string, bytes: Uint8Array, generationId: string, format: 'mp3' | 'wav') {
  if (!bytes.length || bytes.length > MAX_SFX_BYTES) throw invalid();
  await adminBucket().file(sfxOriginalPath(uid, generationId)).save(Buffer.from(bytes), { resumable: false, contentType: mimeTypeFor(format) });
}
/** Decode the stored original before accepting it and measure its actual length; the provider already returns the requested format. */
export async function saveSfxAsset(uid: string, bytes: Uint8Array, generationId: string, itemId: string, format: 'mp3' | 'wav'): Promise<SfxAsset> {
  if (!ffmpeg || !bytes.length || bytes.length > MAX_SFX_BYTES) throw invalid();
  const directory = await mkdtemp(join(tmpdir(), 'mdmedia-sfx-'));
  try {
    const input = join(directory, 'input'); await writeFile(input, bytes);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-i', input, '-vn', '-ac', '1', '-ar', '4000', '-f', 'f32le', '-fs', String(MAX_SFX_BYTES + 1024 * 1024), join(directory, 'samples')], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const pcm = await readFile(join(directory, 'samples'));
    const samples = pcm.length / 4, durationMs = Math.round(samples / 4);
    if (!samples || durationMs < 100 || pcm.length > MAX_SFX_BYTES) throw invalid();
    const waveform = Array.from({ length: 256 }, (_, i) => {
      let peak = 0;
      for (let j = Math.floor(i * samples / 256); j < Math.floor((i + 1) * samples / 256); j++) peak = Math.max(peak, Math.abs(pcm.readFloatLE(j * 4)));
      return Math.round(Math.min(1, peak) * 1000) / 1000;
    });
    const bars = waveform.filter((_, i) => i % 4 === 0).map((peak, i) => `<rect x="${i * 7 + 17}" y="${120 - Math.max(3, peak * 95)}" width="3" height="${Math.max(6, peak * 190)}" rx="1.5"/>`).join('');
    const thumbnail = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#171c19"/><g fill="#8ba99a">${bars}</g></svg>`)).webp().toBuffer();
    const id = `sfx_${generationId}`, path = sfxOriginalPath(uid, generationId), thumbnailPath = `media/${uid}/${id}/thumbnail.webp`;
    const mimeType = mimeTypeFor(format);
    await adminBucket().file(thumbnailPath).save(thumbnail, { resumable: false, contentType: 'image/webp' });
    const asset: SfxAsset = { id, ownerUid: uid, generationId, itemId, purpose: 'output', mediaType: 'sfx', path, thumbnailPath, mimeType,
      width: 0, height: 0, durationMs, waveform, byteLength: bytes.length, createdAt: Date.now() };
    await adminDb().collection('mediaAssets').doc(id).set(asset); return asset;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
