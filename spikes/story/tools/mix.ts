// Throwaway: mixes a voice render with one music clip per scene.
// Each scene opens with a few seconds of music alone, then the music drops to a
// bed under the voices and fades. The opening theme returns over the ending.
// Writes final.mp3 and final-timeline.json (line times shifted to match).
//
//   bun spikes/story/tools/mix.ts spikes/story/out/embarrassing-day/run spikes/story/out/embarrassing-day/music spikes/story/out/embarrassing-day/final

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [renderDir, musicDir, outDir] = Bun.argv.slice(2);
if (!renderDir || !musicDir || !outDir) {
  console.error('usage: bun spikes/story/tools/mix.ts <render dir> <music dir> <out dir>');
  process.exit(2);
}

const LEAD_MS = 3000; // music alone before each scene
const OUTRO_MS = 12000; // theme after the last line
const BED = 0.3; // music level under speech, about -10 dB
const RATE = 24000;

interface TimedLine { id: number; scene: number; startMs: number; endMs: number; [k: string]: unknown }
interface Timeline {
  title: string;
  durationMs: number;
  scenes: Array<{ title: string; startMs: number }>;
  music: Array<{ prompt: string; atMs: number }>;
  lines: TimedLine[];
  [k: string]: unknown;
}

const timeline = JSON.parse(readFileSync(join(renderDir, 'timeline.json'), 'utf8')) as Timeline;
const wav = readFileSync(join(renderDir, 'master.wav'));
const pcm = wav.subarray(44);
mkdirSync(outDir, { recursive: true });

// Cut the voice just before each scene's first line and insert the lead.
const sampleAt = (ms: number) => Math.max(0, Math.min(pcm.length / 2, Math.round((ms * RATE) / 1000))) * 2;
const cuts = timeline.scenes.map((s) => Math.max(0, s.startMs - 150));
const parts: Buffer[] = [];
const silence = (ms: number) => Buffer.alloc(Math.round((ms * RATE) / 1000) * 2);
let prev = 0;
cuts.forEach((cut) => {
  parts.push(pcm.subarray(sampleAt(prev), sampleAt(cut)));
  parts.push(silence(LEAD_MS));
  prev = cut;
});
parts.push(pcm.subarray(sampleAt(prev)));
parts.push(silence(OUTRO_MS));
const voice = Buffer.concat(parts);

const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + voice.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(voice.length, 40);
const voicePath = join(outDir, 'voice-spaced.wav');
writeFileSync(voicePath, Buffer.concat([header, voice]));

// Shift every time by the leads inserted before it.
const shiftFor = (ms: number) => LEAD_MS * cuts.filter((c) => c <= ms).length;
const lines = timeline.lines.map((l) => ({ ...l, startMs: l.startMs + shiftFor(l.startMs), endMs: l.endMs + shiftFor(l.startMs) }));
const scenes = timeline.scenes.map((s, k) => ({ ...s, startMs: s.startMs + shiftFor(s.startMs), musicMs: cuts[k]! + LEAD_MS * k }));
const voiceEndMs = Math.round((voice.length / 2 / RATE) * 1000);

// One input per scene clip plus the theme again for the outro.
const clips = scenes.map((s, k) => ({ file: join(musicDir, `${String(k).padStart(2, '0')}.mp3`), atMs: s.musicMs, kind: 'scene' as const }));
clips.push({ file: join(musicDir, '00.mp3'), atMs: voiceEndMs - OUTRO_MS - 1000, kind: 'outro' as const });

const L = LEAD_MS / 1000;
const sceneGain = `if(lt(t,${L}),1,if(lt(t,${L + 1.5}),1-${1 - BED}*(t-${L})/1.5,if(lt(t,${L + 16}),${BED},max(0,${BED}*(1-(t-${L + 16})/6)))))`;
const outroGain = `if(lt(t,1),${BED}+${1 - BED}*t,if(lt(t,${OUTRO_MS / 1000 - 4}),1,max(0,1-(t-${OUTRO_MS / 1000 - 4})/5)))`;

const inputs = ['-i', voicePath, ...clips.flatMap((c) => ['-i', c.file])];
const chains = clips.map((c, i) => {
  const gain = c.kind === 'scene' ? sceneGain : outroGain;
  return `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-18:TP=-2,volume='${gain}':eval=frame,adelay=${Math.max(0, c.atMs)}:all=1[m${i}]`;
});
const graph = [
  `[0:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-17:TP=-2[v]`,
  ...chains,
  `[v]${clips.map((_, i) => `[m${i}]`).join('')}amix=inputs=${clips.length + 1}:duration=first:normalize=0,alimiter=limit=0.89,loudnorm=I=-16:TP=-1.5[out]`,
].join(';');

const ffmpeg = resolve(import.meta.dir, '../../../node_modules/ffmpeg-static/ffmpeg');
const mp3 = join(outDir, 'final.mp3');
const ff = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-b:a', '128k', mp3], { stdio: 'inherit' });
if (ff.status !== 0) throw new Error('ffmpeg failed');

writeFileSync(
  join(outDir, 'final-timeline.json'),
  JSON.stringify({ ...timeline, durationMs: voiceEndMs, scenes, music: clips, lines }, null, 2) + '\n'
);
console.log(`${mp3}  ${(voiceEndMs / 1000).toFixed(1)} s`);
