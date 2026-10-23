import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mixClips, PCM_RATE, wavFromPcm } from '../../src/story/index.js';
import { createNodeAudioRuntime, resolveFfmpeg } from '../../src/story/node/index.js';

function tone(ms: number, hz: number): Uint8Array {
  const n = Math.round((ms * PCM_RATE) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / PCM_RATE) * 6000);
  return new Uint8Array(out.buffer);
}

let ffmpeg: string | undefined;
try {
  ffmpeg = resolveFfmpeg();
} catch (error) {
  console.log(`Skipping audio runtime tests: ${(error as Error).message}`);
}

describe.if(Boolean(ffmpeg))('Node audio runtime', () => {
  it('mixes clips at their offsets into a normalized 48 kHz stereo master and an MP3', async () => {
    const runtime = createNodeAudioRuntime({ ffmpegPath: ffmpeg });
    const pcm = mixClips([{ pcm: tone(1500, 440), startMs: 0 }, { pcm: tone(1500, 660), startMs: 2000 }], 3500);
    const master = await runtime.mix({ voice: pcm, beds: [], durationMs: 3500 }, { loudnessLufs: -19, truePeakDb: -2 });
    const view = new DataView(master.buffer, master.byteOffset);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    const durationMs = ((master.byteLength - 44) / 4 / 48_000) * 1000;
    expect(Math.abs(durationMs - 3500)).toBeLessThan(20);

    // Integrated loudness, as ffmpeg's EBU R128 meter reports it.
    const dir = mkdtempSync(join(tmpdir(), 'story-runtime-'));
    writeFileSync(join(dir, 'master.wav'), master);
    const meter = spawnSync(ffmpeg!, ['-hide_banner', '-nostats', '-i', join(dir, 'master.wav'), '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(meter.stderr.split('Summary:')[1] ?? '')?.[1]);
    expect(Math.abs(integrated - -19)).toBeLessThan(1.5);

    const mp3 = await runtime.mp3(master, 160);
    expect(mp3.byteLength).toBeGreaterThan(10_000);
    expect((await runtime.describe()).version).toContain('ffmpeg version');
  });

  it('converts a PNG to WebP', async () => {
    const runtime = createNodeAudioRuntime({ ffmpegPath: ffmpeg });
    const dir = mkdtempSync(join(tmpdir(), 'story-runtime-'));
    const png = join(dir, 'in.png');
    spawnSync(ffmpeg!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1', png]);
    const webp = await runtime.webp(new Uint8Array(readFileSync(png)), 82);
    expect(new TextDecoder().decode(webp.slice(8, 12))).toBe('WEBP');
  });

  it('lays a music bed under the voice: loud for the lead, ducked after it', async () => {
    const runtime = createNodeAudioRuntime({ ffmpegPath: ffmpeg });
    // Voice speaks from 3 s to 7 s; the bed starts at 0 with a 3 s lead.
    const voice = mixClips([{ pcm: tone(4000, 440), startMs: 3000 }], 7000);
    const music = wavFromPcm(tone(10_000, 220));
    const plan = {
      voice,
      beds: [{ audio: music, mimeType: 'audio/wav', atMs: 0, envelope: [[0, 1], [3000, 1], [4500, 0.3], [9000, 0.3], [10_000, 0]] as Array<[number, number]> }],
      durationMs: 10_000,
    };
    const master = await runtime.mix(plan, { loudnessLufs: -19, truePeakDb: -2 });
    const durationMs = ((master.byteLength - 44) / 4 / 48_000) * 1000;
    expect(Math.abs(durationMs - 10_000)).toBeLessThan(30);

    // The bed alone in the lead (gain 1) against the bed alone after the voice
    // ends but while it is still ducked (gain 0.3, about -10.5 dB).
    const dir = mkdtempSync(join(tmpdir(), 'story-bed-'));
    writeFileSync(join(dir, 'master.wav'), master);
    const level = (from: number, to: number) => {
      const r = spawnSync(ffmpeg!, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', join(dir, 'master.wav'), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
    };
    const ducked = level(0.5, 2.5) - level(7.3, 8.7);
    expect(ducked).toBeGreaterThan(9);
    expect(ducked).toBeLessThan(12);
  });
});
