import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findFfmpeg } from '../../src/cut/align.js';
import { loadCutForRender, planLoadedRender, runRender } from '../../src/cut/render/run.js';

/**
 * `mdmedia cut render` end to end, with ffmpeg: a small cut over media made
 * here (a tone take, a take with no sound track, a still, a TTS-like file and
 * a PNG), rendered and measured. The CRT TV ports are proved against their
 * original renders separately (see docs/cut-render.md); this checks the
 * pieces on any machine with ffmpeg.
 */

const execute = promisify(execFile);
let ffmpeg = '';
let dir = '';
const FPS = 24;

async function ff(...args: string[]): Promise<void> {
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}

/** The video as grey frames (their mean brightness) and the sound as mono 8 kHz samples. */
async function decode(file: string, width: number, height: number): Promise<{ frames: number[]; sound: Float32Array }> {
  const video = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const size = width * height;
  const frames: number[] = [];
  for (let at = 0; at + size <= video.stdout.length; at += size) {
    let sum = 0;
    for (let i = at; i < at + size; i++) sum += video.stdout[i];
    frames.push(sum / size);
  }
  const audio = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = audio.stdout;
  return { frames, sound: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

/** RMS of the sound between two times, in dBFS. */
function level(sound: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.floor(from * 8000);
  const b = Math.floor(to * 8000);
  for (let i = a; i < b; i++) sum += sound[i] ** 2;
  return 10 * Math.log10(Math.max(1e-12, sum / (b - a)));
}

const CUT = {
  format: 'mdmedia.cut@1',
  meta: { title: 'Render test', fps: FPS, width: 160, height: 90, length: 3.05 },
  media: { root: '.' },
  output: 'takes/out.mp4',
  segments: [
    // A dark take with a 440 Hz tone, 0.5–1.5 s of it, then a 0.25 s freeze (its sound stops at its out).
    { id: 'tone', src: 'take:tone', in: 0.5, out: 1.5, hold: 0.25, mix: { fadeIn: 0.012, fadeOut: 0.012 } },
    // A take with no sound track at all: silent, with a note.
    { id: 'mute', src: 'take:mute', in: 0, out: 0.8 },
    // A white still with a beep as its sound, pushing in.
    { id: 'card', src: 'white.png', still: true, duration: 1.0,
      audio: { synth: { kind: 'tone', frequency: 1950, gain: 0.125 }, out: 0.2, volume: 0.35 },
      zoom: { keys: [{ at: 0, scale: 1 }, { at: 'card.end', scale: 1.2 }] } },
  ],
  lines: [{ id: 'hello', speaker: 'Voice', text: 'Hello.', src: 'audio/voice.wav', at: 'mute+0.2', duration: 0.4 }],
  overlays: [{ id: 'flash', src: 'white.png', at: 'mute+0.25', until: 'mute+0.5' }],
};

beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  dir = await mkdtemp(path.join(tmpdir(), 'mdmedia-render-'));
  await mkdir(path.join(dir, 'takes'));
  await mkdir(path.join(dir, 'audio'));
  await ff('-f', 'lavfi', '-i', `color=c=0x202020:s=160x90:r=${FPS}:d=2`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'takes/tone.mp4'));
  await ff('-f', 'lavfi', '-i', `color=c=0x404040:s=160x90:r=${FPS}:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'takes/mute.mp4'));
  await ff('-f', 'lavfi', '-i', 'color=c=white:s=160x90', '-frames:v', '1', path.join(dir, 'white.png'));
  await ff('-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=24000:duration=0.4', '-c:a', 'pcm_s16le', path.join(dir, 'audio/voice.wav'));
  await writeFile(path.join(dir, 'test.cut.json'), JSON.stringify(CUT));
}, 60_000);

afterAll(async () => {
  // MDMEDIA_KEEP_RENDER_TEST keeps the media and renders, to look at them.
  if (dir && !process.env.MDMEDIA_KEEP_RENDER_TEST) await rm(dir, { recursive: true, force: true });
  else if (dir) console.log(`kept ${dir}`);
});

describe('rendering a cut with ffmpeg', () => {
  it('puts every segment, sound and overlay on the cut\'s times', async () => {
    const loaded = await loadCutForRender(path.join(dir, 'test.cut.json'), { ffmpeg });
    const planned = planLoadedRender(loaded, { output: path.join(dir, 'renders/full.mp4'), preset: 'ultrafast' });
    if (!planned.ok) throw new Error(planned.errors.join('\n'));
    expect(planned.plan.notes).toEqual(["segment mute: take:mute has no sound track, so the segment's own sound is silent"]);
    await runRender(planned.plan, { ffmpeg });
    const { frames, sound } = await decode(path.join(dir, 'renders/full.mp4'), 160, 90);

    // 3.05 s at 24 fps: frames 0 to 73. tone is frames 0–29 (to 1.25 s), mute 30–49 (to 2.05 s), card 50–73.
    expect(frames).toHaveLength(74);
    const dark = frames[10];
    expect(Math.abs(frames[29] - dark)).toBeLessThan(2);
    expect(frames[30]).toBeGreaterThan(dark + 10);
    // The flash covers mute+0.25 through mute+0.5 (1.5–1.75 s), frames 36 to 42, both ends included.
    expect(frames[35]).toBeLessThan(100);
    expect(frames[36]).toBeGreaterThan(200);
    expect(frames[42]).toBeGreaterThan(200);
    expect(frames[43]).toBeLessThan(100);
    // The white card from frame 50.
    expect(frames[49]).toBeLessThan(100);
    expect(frames[50]).toBeGreaterThan(200);

    // The tone under the shot, silence in its freeze, the voice line, then the beep.
    expect(level(sound, 0.1, 0.9)).toBeGreaterThan(-25);
    expect(level(sound, 1.05, 1.2)).toBeLessThan(-60);
    expect(level(sound, 1.28, 1.42)).toBeLessThan(-60);
    expect(level(sound, 1.5, 1.8)).toBeGreaterThan(-25);
    expect(level(sound, 1.9, 2.0)).toBeLessThan(-60);
    expect(level(sound, 2.08, 2.22)).toBeGreaterThan(-40);
    expect(level(sound, 2.3, 3.0)).toBeLessThan(-60);
  }, 120_000);

  it('renders a stretch of it, small and fast, with the same times', async () => {
    const loaded = await loadCutForRender(path.join(dir, 'test.cut.json'), { ffmpeg });
    const planned = planLoadedRender(loaded, { output: path.join(dir, 'renders/part.mp4'), from: 1.4, to: 2.4, preview: true });
    if (!planned.ok) throw new Error(planned.errors.join('\n'));
    await runRender(planned.plan, { ffmpeg });
    const { frames, sound } = await decode(path.join(dir, 'renders/part.mp4'), 80, 46);
    // Frames 34 up to 58 of the whole: 24 of them.
    expect(frames).toHaveLength(24);
    expect(frames[1]).toBeLessThan(100);
    expect(frames[2]).toBeGreaterThan(200); // frame 36, the flash's first
    expect(frames[15]).toBeLessThan(100); // frame 49, the end of mute
    expect(frames[16]).toBeGreaterThan(200); // frame 50, the card
    expect(level(sound, 0.15, 0.35)).toBeGreaterThan(-25); // the voice, 1.5–1.8 s
    expect(level(sound, 0.68, 0.82)).toBeGreaterThan(-40); // the beep, 2.05–2.25 s
  }, 120_000);

  it('is wired into the CLI as mdmedia cut render', async () => {
    const bin = path.join(import.meta.dir, '../../src/bin.ts');
    const { stdout } = await execute('bun', [bin, 'cut', 'render', path.join(dir, 'test.cut.json'), '--print', '--from', 'mute', '--to', 'card.end']);
    expect(stdout).toContain('-filter_complex');
    expect(stdout).toContain(path.join(dir, 'renders', 'test.1.25-3.05.mp4'));
    expect(existsSync(path.join(dir, 'renders', 'test.1.25-3.05.mp4'))).toBe(false);
  }, 60_000);
});
