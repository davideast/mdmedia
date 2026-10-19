// Throwaway: builds the comic reader site from comic.json and drawn panels.
//
//   bun spikes/story/tools/comic-page.ts <comic.json> <art dir> <site dir>

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [comicPath, artDir, siteDir] = Bun.argv.slice(2);
if (!comicPath || !artDir || !siteDir) {
  console.error('usage: bun spikes/story/tools/comic-page.ts <comic.json> <art dir> <site dir>');
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

const template = readFileSync(resolve(import.meta.dir, 'comic.html'), 'utf8');
writeFileSync(join(siteDir, 'index.html'), template.replace('/*DATA*/null', JSON.stringify(comic)));
console.log(join(siteDir, 'index.html'));
