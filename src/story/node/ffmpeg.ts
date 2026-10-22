import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { wavFromPcm } from '../pcm.js';
import type { AudioRuntime } from '../ports.js';
import { StoryError } from '../types.js';

const run = promisify(execFile);

/**
 * Finds ffmpeg: `MDMEDIA_FFMPEG`, then an installed `ffmpeg-static`, then
 * `ffmpeg` on the PATH. `ffmpeg-static` is optional because its binary is
 * GPL-3.0; mdmedia never bundles it.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MDMEDIA_FFMPEG;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new StoryError('ffmpeg-missing', `MDMEDIA_FFMPEG points to ${fromEnv}, which does not exist.`);
  }
  try {
    const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // ffmpeg-static is not installed.
  }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  throw new StoryError(
    'ffmpeg-missing',
    'ffmpeg was not found. Install ffmpeg, add ffmpeg-static to your project, or set MDMEDIA_FFMPEG to its path.'
  );
}

export function createNodeAudioRuntime(options: { ffmpegPath?: string } = {}): AudioRuntime {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpeg();

  async function convert(input: Uint8Array, args: string[], ext: string): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-story-'));
    try {
      const src = join(dir, 'in.wav');
      const dst = join(dir, `out.${ext}`);
      await writeFile(src, input);
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, ...args, dst], { maxBuffer: 16 * 1024 * 1024 });
      return new Uint8Array(await readFile(dst));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    master: (pcm, target) =>
      convert(wavFromPcm(pcm), [
        '-af', `loudnorm=I=${target.loudnessLufs}:TP=${target.truePeakDb}:LRA=11`,
        '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
      ], 'wav'),
    mp3: (wav, kbps) => convert(wav, ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`], 'mp3'),
    async describe() {
      const { stdout } = await run(ffmpeg, ['-version']);
      return { path: ffmpeg, version: stdout.split('\n')[0]!.trim() };
    },
  };
}
