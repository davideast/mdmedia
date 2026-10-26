import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pcmFromWav, wavFromPcm } from '../pcm.js';
import type { ImageBytes } from '../ports.js';

/**
 * What David approved for one comic, kept beside the comic script: panel
 * images, cast voices and line takes. A build uses locked items as they are;
 * changing checks, prompts or cache versions can't replace them (plan 009).
 */
export interface ComicLockManifest {
  schema: 'mdmedia.story.lock/1';
  /** Panel id → image file in the lock folder. */
  panels: Record<string, { file: string; sha256: string }>;
  /** Cast id → voice. */
  cast: Record<string, string>;
  /** Comic item id (`3.2-1`) → take file in the lock folder. */
  lines: Record<string, { file: string; sha256: string }>;
}

export interface ComicLock {
  images: Map<string, ImageBytes>;
  cast: Record<string, string>;
  /** 24 kHz mono PCM takes by item id. */
  lines: Map<string, Uint8Array>;
}

/** `comics/lunch.md` → `comics/lunch.lock.json` and `comics/lunch.lock/` */
export const lockFiles = (comicPath: string) => {
  const base = join(dirname(comicPath), basename(comicPath).replace(/\.md$/, ''));
  return { manifest: `${base}.lock.json`, dir: `${base}.lock` };
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const emptyManifest = (): ComicLockManifest => ({ schema: 'mdmedia.story.lock/1', panels: {}, cast: {}, lines: {} });

export async function readLockManifest(comicPath: string): Promise<ComicLockManifest> {
  const { manifest } = lockFiles(comicPath);
  return existsSync(manifest) ? (JSON.parse(await readFile(manifest, 'utf8')) as ComicLockManifest) : emptyManifest();
}

/** Loads the locked items, leaving out the ids in `unlock` (panel ids, cast ids or item ids). */
export async function readComicLock(comicPath: string, unlock: string[] = []): Promise<ComicLock> {
  const m = await readLockManifest(comicPath);
  const { dir } = lockFiles(comicPath);
  const skip = new Set(unlock);
  const images = new Map<string, ImageBytes>();
  for (const [id, { file, sha256 }] of Object.entries(m.panels)) {
    if (skip.has(id)) continue;
    const bytes = new Uint8Array(await readFile(join(dir, file)));
    if (sha(bytes) !== sha256) throw new Error(`The locked image for panel ${id} (${file}) has changed on disk.`);
    images.set(id, { bytes, mimeType: file.endsWith('.webp') ? 'image/webp' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' });
  }
  const lines = new Map<string, Uint8Array>();
  for (const [id, { file, sha256 }] of Object.entries(m.lines)) {
    if (skip.has(id)) continue;
    const wav = new Uint8Array(await readFile(join(dir, file)));
    if (sha(wav) !== sha256) throw new Error(`The locked take for ${id} (${file}) has changed on disk.`);
    lines.set(id, pcmFromWav(wav));
  }
  const cast = Object.fromEntries(Object.entries(m.cast).filter(([id]) => !skip.has(id)));
  return { images, cast, lines };
}

/** Adds items to the lock, replacing any with the same id. */
export async function addToComicLock(
  comicPath: string,
  add: { images?: Map<string, ImageBytes>; cast?: Record<string, string>; lines?: Map<string, Uint8Array> }
): Promise<ComicLockManifest> {
  const m = await readLockManifest(comicPath);
  const { manifest, dir } = lockFiles(comicPath);
  await mkdir(dir, { recursive: true });
  for (const [id, image] of add.images ?? []) {
    const ext = image.mimeType.includes('webp') ? 'webp' : image.mimeType.includes('jpeg') ? 'jpg' : 'png';
    const file = `panel-${id.replace('.', '-')}.${ext}`;
    await writeFile(join(dir, file), image.bytes);
    m.panels[id] = { file, sha256: sha(image.bytes) };
  }
  for (const [id, pcm] of add.lines ?? []) {
    const file = `line-${id.replace(/\./g, '-')}.wav`;
    const wav = wavFromPcm(pcm);
    await writeFile(join(dir, file), wav);
    m.lines[id] = { file, sha256: sha(wav) };
  }
  Object.assign(m.cast, add.cast ?? {});
  await writeFile(manifest, JSON.stringify(m, null, 2) + '\n');
  return m;
}
