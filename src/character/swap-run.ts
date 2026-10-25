import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findFfmpeg } from '../cut/align.js';
import { decodeWav } from '../cut/onset.js';
import { probeMedia, runFfmpeg } from '../cut/render/run.js';
import type { Aligner } from '../cut/words.js';
import { DEFAULT_STS_MODEL, pcmToWav, speechToSpeech, type SpeechToSpeechSettings } from '../elevenlabs/speech-to-speech.js';
import { compareSwap, type SwapComparison } from './swap.js';

/**
 * The voice swap, on files: a take's speech is converted to a character's
 * voice with ElevenLabs speech-to-speech and put back under the same
 * picture, so the lips, timing and acting stay the take's own and only the
 * voice changes. Writes, next to `out`:
 *
 * - `<out>` the take with the converted voice (the picture copied, not re-encoded);
 * - `<name>.before.wav` and `<name>.after.wav`, the speech as sent and as returned;
 * - `<name>.swap.json`, the settings and, given the line's text, the comparison.
 *
 * Nothing is ever overwritten.
 */

/** The sample rate the swap sends the take's speech at. */
export const SWAP_SAMPLE_RATE = 44_100;
/** The PCM rate it asks back: ElevenLabs keeps `pcm_44100` for its Pro tier, and 24 kHz holds speech whole. */
export const SWAP_RETURN_RATE = 24_000;

export interface SwapVoiceOptions {
  video: string;
  out: string;
  apiKey: string;
  voice: { id: string; name: string };
  model?: string;
  settings?: SpeechToSpeechSettings;
  /** ElevenLabs' audio isolation on the input first. Default true: a take's crowd or room noise is dropped, and the edit lays its own bed. */
  removeBackgroundNoise?: boolean;
  seed?: number;
  /** The words spoken, to align before and after and compare them. */
  text?: string;
  aligner?: Aligner;
  ffmpeg?: string;
  /** Replaces the speech-to-speech call, for tests. */
  convert?: (wav: Uint8Array) => Promise<Uint8Array>;
}

export interface SwapReport {
  format: 'mdmedia.voice-swap@1';
  video: string;
  out: string;
  before: string;
  after: string;
  voice: { id: string; name: string };
  model: string;
  settings: SpeechToSpeechSettings;
  removeBackgroundNoise: boolean;
  seed: number | null;
  text: string | null;
  comparison: SwapComparison | null;
  madeAt: string;
}

/** `<dir>/<stem>`: the stem `out` shares with its `.before.wav`, `.after.wav` and `.swap.json`. */
export function swapStem(out: string): string {
  return path.join(path.dirname(out), path.basename(out).replace(/\.[^.]+$/, ''));
}

async function toAlignerWav(file: string, ffmpeg: string, dir: string, name: string): Promise<{ bytes: Uint8Array; sampleRate: number }> {
  const out = path.join(dir, `${name}.wav`);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { ffmpeg, what: 'preparing audio to align' });
  return { bytes: new Uint8Array(await readFile(out)), sampleRate: 16_000 };
}

export async function swapVoice(options: SwapVoiceOptions): Promise<SwapReport> {
  const ffmpeg = options.ffmpeg ?? (await findFfmpeg());
  const video = path.resolve(options.video);
  const out = path.resolve(options.out);
  const stem = swapStem(out);
  const files = { before: `${stem}.before.wav`, after: `${stem}.after.wav`, report: `${stem}.swap.json` };
  const taken = [out, ...Object.values(files)].filter((f) => existsSync(f));
  if (taken.length > 0) throw new Error(`Won't overwrite ${taken.join(', ')}: choose another output name.`);
  const info = await probeMedia(video, ffmpeg);
  if (!info.hasAudio) throw new Error(`${video} has no sound to swap.`);
  const model = options.model ?? DEFAULT_STS_MODEL;
  const removeBackgroundNoise = options.removeBackgroundNoise ?? true;
  const settings = options.settings ?? {};

  const made: string[] = [];
  try {
    return await swapFiles();
  } catch (error) {
    // A failed swap leaves nothing half-made behind, so the same name can be run again.
    await Promise.all(made.map((f) => rm(f, { force: true })));
    throw error;
  }

  async function swapFiles(): Promise<SwapReport> {
  // 1. The take's speech, as sent.
  made.push(files.before);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', video, '-vn', '-ac', '1', '-ar', String(SWAP_SAMPLE_RATE), '-c:a', 'pcm_s16le', files.before], { ffmpeg, what: 'taking the speech out of the take' });
  const beforeBytes = new Uint8Array(await readFile(files.before));

  // 2. Converted.
  const convert = options.convert ?? ((wav: Uint8Array) => speechToSpeech(wav, {
    apiKey: options.apiKey, voiceId: options.voice.id, model, settings, removeBackgroundNoise, seed: options.seed, outputFormat: `pcm_${SWAP_RETURN_RATE}`,
  }));
  const pcm = await convert(beforeBytes);
  made.push(files.after);
  await writeFile(files.after, pcmToWav(pcm, SWAP_RETURN_RATE), { flag: 'wx' });

  // 3. Back under the picture: the picture copied, the new voice padded or cut to the take's length.
  const length = info.length;
  made.push(out);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', video, '-i', files.after,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    ...(length ? ['-t', length.toFixed(3)] : ['-shortest']), out,
  ], { ffmpeg, what: 'putting the new voice under the picture' });

  // 4. Compared, given the words.
  let comparison: SwapComparison | null = null;
  if (options.text && options.aligner) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-swap-'));
    try {
      const [a, b] = await Promise.all([toAlignerWav(files.before, ffmpeg, dir, 'before'), toAlignerWav(files.after, ffmpeg, dir, 'after')]);
      const [beforeAligned, afterAligned] = await Promise.all([options.aligner.align(a, options.text), options.aligner.align(b, options.text)]);
      comparison = compareSwap({
        before: decodeWav(beforeBytes),
        after: decodeWav(new Uint8Array(await readFile(files.after))),
        beforeWords: beforeAligned.words,
        afterWords: afterAligned.words,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const report: SwapReport = {
    format: 'mdmedia.voice-swap@1',
    video, out, before: files.before, after: files.after,
    voice: options.voice, model, settings, removeBackgroundNoise, seed: options.seed ?? null,
    text: options.text ?? null, comparison, madeAt: new Date().toISOString(),
  };
  made.push(files.report);
  await writeFile(files.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
  }
}
