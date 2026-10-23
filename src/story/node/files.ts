import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pcmFromWav, wavFromPcm } from '../pcm.js';
import type { CachedLine, FileSink, RenderCache } from '../ports.js';

/** Writes a build's files under one folder, creating subfolders as needed. */
export function createFileSink(root: string): FileSink {
  return {
    async write(path, data) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
  };
}

/**
 * Renders on disk. Lines: `<dir>/<key>.wav` (playable) and `<dir>/<key>.json`
 * (the check result and whether the take was accepted). Music:
 * `<dir>/<key>.mp3` or `.wav`.
 */
export function createFileRenderCache(dir: string): RenderCache {
  const name = (key: string) => key.replace(/[^a-z0-9]+/gi, '-');
  return {
    async get(key) {
      try {
        const meta = JSON.parse(await readFile(join(dir, `${name(key)}.json`), 'utf8')) as Omit<CachedLine, 'pcm'>;
        const wav = new Uint8Array(await readFile(join(dir, `${name(key)}.wav`)));
        return { ...meta, pcm: pcmFromWav(wav) };
      } catch {
        return undefined;
      }
    },
    async put(key, line) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name(key)}.wav`), wavFromPcm(line.pcm));
      await writeFile(join(dir, `${name(key)}.json`), JSON.stringify({ check: line.check, accepted: line.accepted }, null, 2) + '\n');
    },
    async getMusic(key) {
      for (const [ext, mimeType] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav']] as const) {
        try {
          return { bytes: new Uint8Array(await readFile(join(dir, `${name(key)}.${ext}`))), mimeType };
        } catch {
          // Try the next format.
        }
      }
      return undefined;
    },
    async getImage(key) {
      try {
        const meta = JSON.parse(await readFile(join(dir, `${name(key)}.image.json`), 'utf8')) as { mimeType: string; meta: Record<string, unknown> };
        return { ...meta, bytes: new Uint8Array(await readFile(join(dir, `${name(key)}.${extension(meta.mimeType)}`))) };
      } catch {
        return undefined;
      }
    },
    async putImage(key, image) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name(key)}.${extension(image.mimeType)}`), image.bytes);
      await writeFile(join(dir, `${name(key)}.image.json`), JSON.stringify({ mimeType: image.mimeType, meta: image.meta }, null, 2) + '\n');
    },
    async putMusic(key, music) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name(key)}.${music.mimeType.includes('wav') ? 'wav' : 'mp3'}`), music.bytes);
    },
  };
}

function extension(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('json')) return 'data.json';
  return 'bin';
}
