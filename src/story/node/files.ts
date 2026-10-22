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
 * Rendered lines on disk: `<dir>/<key>.wav` (playable) and `<dir>/<key>.json`
 * (the check result and whether the take was accepted).
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
  };
}
