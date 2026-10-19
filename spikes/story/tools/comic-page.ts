// Throwaway: builds the comic reader site from comic.json and drawn panels.
//
//   bun spikes/story/tools/comic-page.ts <comic.json> <art dir> <site dir>

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [comicPath, artDir, siteDir, audioDir] = Bun.argv.slice(2);
if (!comicPath || !artDir || !siteDir) {
  console.error('usage: bun spikes/story/tools/comic-page.ts <comic.json> <art dir> <site dir> [audio dir]');
  process.exit(2);
}
const ffmpeg = resolve(import.meta.dir, '../../../node_modules/ffmpeg-static/ffmpeg');
const comic = JSON.parse(readFileSync(comicPath, 'utf8')) as { panels: Array<{ id: number; faces?: unknown }> };
const facesPath = join(artDir, 'faces.json');
const faces = existsSync(facesPath) ? JSON.parse(readFileSync(facesPath, 'utf8')) : {};
for (const p of comic.panels) p.faces = faces[p.id] ?? [];
mkdirSync(join(siteDir, 'img'), { recursive: true });

for (const p of comic.panels) {
  const name = String(p.id).padStart(2, '0');
  const src = join(artDir, `panel-${name}.png`);
  const dst = join(siteDir, 'img', `${name}.webp`);
  if (!existsSync(src)) { console.error(`missing art for panel ${name}`); continue; }
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=1000:-2', '-c:v', 'libwebp', '-quality', '80', dst]);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${src}`);
}

// Voices: one line per caption and balloon, in reading order (render.ts line mode).
if (audioDir) {
  const timeline = JSON.parse(readFileSync(join(audioDir, 'timeline.json'), 'utf8')) as { lines: Array<{ startMs: number; endMs: number }> };
  let i = 0;
  for (const p of comic.panels as Array<{ items: Array<{ kind: string; startMs?: number; endMs?: number }> }>) {
    for (const item of p.items) {
      if (item.kind === 'sfx') continue;
      const line = timeline.lines[i++];
      if (line) { item.startMs = line.startMs; item.endMs = line.endMs; }
    }
  }
  if (i !== timeline.lines.length) throw new Error(`voice lines (${timeline.lines.length}) do not match items (${i})`);
  const mp3 = readdirSync(audioDir).find((f) => f.endsWith('.mp3'))!;
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', join(audioDir, mp3), '-b:a', '96k', join(siteDir, 'audio.mp3')]);
  if (r.status !== 0) throw new Error('ffmpeg failed on audio');
  (comic as { audio?: boolean }).audio = true;
}

const template = readFileSync(resolve(import.meta.dir, 'comic.html'), 'utf8');
writeFileSync(join(siteDir, 'index.html'), template.replace('/*DATA*/null', JSON.stringify(comic)));
console.log(join(siteDir, 'index.html'));
