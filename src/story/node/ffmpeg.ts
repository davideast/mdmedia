import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { wavFromPcm } from '../pcm.js';
import type { AudioRuntime, MixPlan } from '../ports.js';
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

  async function convert(input: Uint8Array, args: string[], ext: string, inputExt = 'wav'): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-story-'));
    try {
      const src = join(dir, `in.${inputExt}`);
      const dst = join(dir, `out.${ext}`);
      await writeFile(src, input);
      await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, ...args, dst], { maxBuffer: 16 * 1024 * 1024 });
      return new Uint8Array(await readFile(dst));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function mix(plan: MixPlan, target: { loudnessLufs: number; truePeakDb: number }): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-story-'));
    try {
      const voice = join(dir, 'voice.wav');
      await writeFile(voice, wavFromPcm(plan.voice));
      const inputs = ['-i', voice];
      for (const [i, bed] of plan.beds.entries()) {
        const file = join(dir, `bed-${i}.${bed.mimeType.includes('wav') ? 'wav' : 'mp3'}`);
        await writeFile(file, bed.audio);
        inputs.push('-i', file);
      }
      // Pass 1: mix to an unnormalized file. Pass 2: measure it, then apply one
      // fixed gain. One-pass loudnorm rides the gain as it plays and undoes the
      // ducking of the music beds.
      const mixed = join(dir, 'mixed.wav');
      await run(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', mixGraph(plan), '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', mixed], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const out = join(dir, 'master.wav');
      await normalize(mixed, out, target);
      return new Uint8Array(await readFile(out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Two-pass loudness normalization with a linear gain, to a 48 kHz stereo 16-bit WAV. */
  async function normalize(input: string, output: string, target: { loudnessLufs: number; truePeakDb: number }) {
    const spec = `I=${target.loudnessLufs}:TP=${target.truePeakDb}:LRA=20`;
    const measured = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', input, '-af', `loudnorm=${spec}:print_format=json`, '-f', 'null', '-'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const start = measured.stderr.lastIndexOf('{');
    const stats = JSON.parse(measured.stderr.slice(start, measured.stderr.indexOf('}', start) + 1)) as Record<string, string>;
    const linear =
      `loudnorm=${spec}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}` +
      `:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-af', `${linear},aresample=48000`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output], {
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  return {
    mix,
    mp3: (wav, kbps) => convert(wav, ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`], 'mp3'),
    webp: (image, quality) => convert(image, ['-c:v', 'libwebp', '-quality', String(quality)], 'webp', image[0] === 0xff ? 'jpg' : 'png'),
    async describe() {
      const { stdout } = await run(ffmpeg, ['-version']);
      return { path: ffmpeg, version: stdout.split('\n')[0]!.trim() };
    },
  };
}

/**
 * One ffmpeg graph: the voice resampled to 48 kHz stereo; each bed normalized
 * to -18 LUFS, shaped by its envelope and delayed to its start; mixed without
 * level normalization, limited, and padded or trimmed to the plan's length.
 * Loudness normalization to the target is a separate, two-pass step.
 */
export function mixGraph(plan: MixPlan): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const chains = [`[0:a]aresample=48000,aformat=channel_layouts=stereo[v]`];
  plan.beds.forEach((bed, i) => {
    chains.push(
      `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-18:TP=-2,aresample=48000,` +
        `volume='${envelopeExpression(bed.envelope)}':eval=frame,adelay=${Math.max(0, Math.round(bed.atMs))}:all=1[m${i}]`
    );
  });
  const mixed = plan.beds.length
    ? `[v]${plan.beds.map((_, i) => `[m${i}]`).join('')}amix=inputs=${plan.beds.length + 1}:duration=longest:normalize=0,alimiter=limit=0.89`
    : '[v]anull';
  chains.push(`${mixed},apad,atrim=0:${seconds(plan.durationMs)}[out]`);
  return chains.join(';');
}

/** A piecewise-linear gain over time, as an ffmpeg expression in `t` (seconds). */
export function envelopeExpression(points: Array<[number, number]>): string {
  if (!points.length) return '1';
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let expr = String(sorted.at(-1)![1]);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const [t0, g0] = sorted[i]!;
    const [t1, g1] = sorted[i + 1]!;
    const a = t0 / 1000;
    const b = t1 / 1000;
    const segment = b > a ? `${g0}+(${g1 - g0})*(t-${a})/${b - a}` : String(g1);
    expr = `if(lt(t,${b}),${segment},${expr})`;
  }
  return expr;
}
