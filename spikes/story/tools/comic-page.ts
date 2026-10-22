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
const comic = JSON.parse(readFileSync(comicPath, 'utf8')) as { panels: Array<{ id: number; faces?: Record<string, unknown> }>; arts?: unknown };

// Art: one dir, or several takes as "id:label=dir,..." to compare.
const artTakes = artDir.includes('=')
  ? artDir.split(',').map((t) => { const [head, dir] = t.split('=') as [string, string]; const [id, label] = head.split(':') as [string, string?]; return { id, label: label ?? id, dir }; })
  : [{ id: 'A', label: 'Art', dir: artDir }];
for (const take of artTakes) {
  const facesPath = join(take.dir, 'faces.json');
  const faces = existsSync(facesPath) ? JSON.parse(readFileSync(facesPath, 'utf8')) : {};
  mkdirSync(join(siteDir, 'img', take.id), { recursive: true });
  for (const p of comic.panels) {
    (p.faces ??= {})[take.id] = faces[p.id] ?? [];
    const name = String(p.id).padStart(2, '0');
    const src = join(take.dir, `panel-${name}.png`);
    if (!existsSync(src)) { console.error(`${take.id}: missing art for panel ${name}`); continue; }
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=1000:-2', '-c:v', 'libwebp', '-quality', '80', join(siteDir, 'img', take.id, `${name}.webp`)]);
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${src}`);
  }
}
comic.arts = artTakes.map(({ id, label }) => ({ id, label }));

// Voices: one line per caption and balloon, in reading order (render.ts line
// mode). Either one render dir, or several as "A=dir,B=dir" to compare takes.
if (audioDir) {
  // Each take is "id:label=dir"; a bare dir is one unlabeled take.
  const takes = audioDir.includes('=')
    ? audioDir.split(',').map((t) => { const [head, dir] = t.split('=') as [string, string]; const [id, label] = head.split(':') as [string, string?]; return { id, label: label ?? id, dir }; })
    : [{ id: 'A', label: 'Voices', dir: audioDir }];
  const versions: Array<{ id: string; label: string; file: string }> = [];
  for (const { id, label, dir } of takes) {
    const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { lines: Array<{ startMs: number; endMs: number }> };
    let i = 0;
    for (const p of comic.panels as Array<{ items: Array<{ kind: string; audio?: Record<string, [number, number]> }> }>) {
      for (const item of p.items) {
        if (item.kind === 'sfx') continue;
        const line = timeline.lines[i++];
        if (line) (item.audio ??= {})[id] = [line.startMs, line.endMs];
      }
    }
    if (i !== timeline.lines.length) throw new Error(`${id}: voice lines (${timeline.lines.length}) do not match items (${i})`);
    const mp3 = readdirSync(dir).find((f) => f.endsWith('.mp3'))!;
    const file = `audio-${id}.mp3`;
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', join(dir, mp3), '-b:a', '96k', join(siteDir, file)]);
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${id}`);
    versions.push({ id, label, file });
  }
  (comic as { voices?: unknown }).voices = versions;
}

const template = readFileSync(resolve(import.meta.dir, 'comic.html'), 'utf8');
writeFileSync(join(siteDir, 'index.html'), template.replace('/*DATA*/null', JSON.stringify(comic)));
console.log(join(siteDir, 'index.html'));
