import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mixClips, PCM_RATE } from '../../src/story/index.js';
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
    const master = await runtime.master(pcm, { loudnessLufs: -19, truePeakDb: -2 });
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
});
