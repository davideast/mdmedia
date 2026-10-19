// Throwaway: assembles the reader page from the final mix, its timeline, the
// panel plan and the art versions. Converts panels to WebP and the mix to a
// smaller MP3 so the whole site fits one Artifact publish.
//
//   bun spikes/story/tools/page.ts spikes/story/out/embarrassing-day

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [root] = Bun.argv.slice(2);
if (!root) { console.error('usage: bun spikes/story/tools/page.ts <story out dir>'); process.exit(2); }

const ffmpeg = resolve(import.meta.dir, '../../../node_modules/ffmpeg-static/ffmpeg');
const run = (args: string[]) => {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};

const VERSIONS = [
  { id: 'flat', label: 'Flat color', note: 'Clean ink and flat color. Drawn by gemini-3-pro-image; lettering added by the page.', lettered: false },
  { id: 'watercolor', label: 'Watercolor', note: 'Pen, ink and watercolor. Drawn by gemini-3-pro-image; lettering added by the page.', lettered: false },
  { id: 'manga', label: 'Manga', note: 'Black-and-white manga. Drawn by the faster gemini-3.1-flash-image; lettering added by the page.', lettered: false },
  { id: 'lettered', label: 'Model-lettered', note: 'Flat color with bubbles and captions drawn by the image model itself, to compare with page lettering. Check the spelling.', lettered: true },
];

const timeline = JSON.parse(readFileSync(join(root, 'final', 'final-timeline.json'), 'utf8'));
const plan = JSON.parse(readFileSync(resolve(import.meta.dir, '../embarrassing-day/panels.json'), 'utf8'));
const site = join(root, 'site');
mkdirSync(site, { recursive: true });

const startOf = new Map<number, number>(timeline.lines.map((l: { id: number; startMs: number }) => [l.id, l.startMs]));
const sceneOf = new Map<number, number>(timeline.lines.map((l: { id: number; scene: number }) => [l.id, l.scene - 1]));

const panels = plan.panels.map((p: { id: number; from: number; aspect: string; shot: string; text: unknown[] }) => ({
  id: p.id,
  aspect: p.aspect,
  alt: p.shot,
  text: p.text,
  startMs: Math.max(0, (startOf.get(p.from) ?? 0) - 1500),
  scene: sceneOf.get(p.from) ?? 0,
}));

// Images: 1000 px wide WebP per version.
const versions = [];
for (const v of VERSIONS) {
  const dir = join(root, 'art', v.id);
  if (!existsSync(dir)) continue;
  mkdirSync(join(site, 'img', v.id), { recursive: true });
  let count = 0;
  for (const p of panels) {
    const src = join(dir, `panel-${String(p.id).padStart(2, '0')}.png`);
    const dst = join(site, 'img', v.id, `${String(p.id).padStart(2, '0')}.webp`);
    if (!existsSync(src)) continue;
    if (!existsSync(dst)) run(['-i', src, '-vf', 'scale=1000:-2', '-c:v', 'libwebp', '-quality', '78', dst]);
    count++;
  }
  if (count) versions.push(v);
  console.log(`${v.id}: ${count} panels`);
}

// Audio: 96 kb/s keeps a 20-minute mix under the per-file limit.
const audio = join(site, 'audio.mp3');
if (!existsSync(audio)) run(['-i', join(root, 'final', 'final.mp3'), '-b:a', '96k', audio]);

const data = {
  durationMs: timeline.durationMs,
  scenes: timeline.scenes.map((s: { title: string; startMs: number }) => ({ title: s.title, startMs: s.startMs })),
  lines: timeline.lines.map((l: { speaker: string; narration: boolean; text: string; startMs: number }) => ({
    speaker: l.speaker, narration: l.narration, text: l.text, startMs: l.startMs,
  })),
  panels,
  versions,
  credits:
    'Cast: Milo (Puck), June (Leda), Harper (Zephyr), Mr. Alvarez (Algenib), tech club kid (Achird), crowd (Fenrir). ' +
    'Story text supplied by the author; adapted for voices and panels in this prototype.',
};

const template = readFileSync(resolve(import.meta.dir, 'reader.html'), 'utf8');
writeFileSync(join(site, 'index.html'), template.replace('/*DATA*/null', JSON.stringify(data)));
console.log(join(site, 'index.html'));
