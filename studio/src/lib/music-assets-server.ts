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
import { MAX_MUSIC_BYTES } from './music-request';
const execute = promisify(execFile);
export interface MusicAsset extends StoredAsset { waveform: number[] }
/** Decode before accepting audio, measure its actual length, and honor the requested download format. */
export async function saveMusicAsset(uid: string, bytes: Uint8Array, generationId: string, itemId: string, format: 'mp3' | 'wav'): Promise<MusicAsset> {
  if (!ffmpeg || !bytes.length || bytes.length > MAX_MUSIC_BYTES) throw new MediaError(502, 'invalid_music', 'Lyria returned invalid or oversized audio.');
  const directory = await mkdtemp(join(tmpdir(), 'mdmedia-music-'));
  try {
    const input = join(directory, 'input'); await writeFile(input, bytes);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-i', input, '-vn', '-ac', '1', '-ar', '4000', '-f', 'f32le', '-fs', String(MAX_MUSIC_BYTES + 1024 * 1024), join(directory, 'samples')], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const pcm = await readFile(join(directory, 'samples'));
    const samples = pcm.length / 4, durationMs = Math.round(samples / 4);
    if (!samples || durationMs < 1000 || pcm.length > MAX_MUSIC_BYTES) throw new MediaError(502, 'invalid_music', 'The returned audio could not be decoded.');
    const waveform = Array.from({ length: 256 }, (_, i) => {
      let peak = 0;
      for (let j = Math.floor(i * samples / 256); j < Math.floor((i + 1) * samples / 256); j++) peak = Math.max(peak, Math.abs(pcm.readFloatLE(j * 4)));
      return Math.round(Math.min(1, peak) * 1000) / 1000;
    });
    const filename = join(directory, `track.${format}`);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-i', input, '-vn', ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']), '-fs', String(MAX_MUSIC_BYTES + 1024 * 1024), filename], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const audio = await readFile(filename);
    if (audio.length > MAX_MUSIC_BYTES) throw new MediaError(502, 'output_too_large', 'The music file is too large.');
    const bars = waveform.filter((_, i) => i % 4 === 0).map((peak, i) => `<rect x="${i * 7 + 17}" y="${120 - Math.max(3, peak * 95)}" width="3" height="${Math.max(6, peak * 190)}" rx="1.5"/>`).join('');
    const thumbnail = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#171c19"/><g fill="#8ba99a">${bars}</g></svg>`)).webp().toBuffer();
    const id = `music_${generationId}`, path = `media/${uid}/${id}/original`, thumbnailPath = `media/${uid}/${id}/thumbnail.webp`;
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    await adminBucket().file(path).save(audio, { resumable: false, contentType: mimeType });
    await adminBucket().file(thumbnailPath).save(thumbnail, { resumable: false, contentType: 'image/webp' });
    const asset: MusicAsset = { id, ownerUid: uid, generationId, itemId, purpose: 'output', mediaType: 'music', path, thumbnailPath, mimeType,
      width: 0, height: 0, durationMs, waveform, byteLength: audio.length, createdAt: Date.now() };
    await adminDb().collection('mediaAssets').doc(id).set(asset); return asset;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
