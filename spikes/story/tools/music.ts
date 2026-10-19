// Throwaway: one Lyria clip per music cue in a timeline.
//
//   bun spikes/story/tools/music.ts spikes/story/out/embarrassing-day/run/timeline.json spikes/story/out/embarrassing-day/music

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { LyriaMusicProvider } from '../../../src/music/lyria-music-provider.js';

const [timelinePath, outDir, model = 'lyria-3-clip-preview'] = Bun.argv.slice(2);
if (!timelinePath || !outDir) {
  console.error('usage: bun spikes/story/tools/music.ts <timeline.json> <out dir> [model]');
  process.exit(2);
}

const key = process.env.GEMINI_API_KEY ?? readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim();
const lyria = new LyriaMusicProvider(new GoogleGenAI({ apiKey: key }));
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8')) as { music: Array<{ prompt: string }> };
mkdirSync(outDir, { recursive: true });

// Two at a time; existing files are kept so a rerun only fills gaps.
const queue = timeline.music.map((cue, i) => ({ cue, i }));
await Promise.all(
  Array.from({ length: 2 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const file = join(outDir, `${String(job.i).padStart(2, '0')}.mp3`);
      if (existsSync(file)) continue;
      const prompt = `Instrumental only, no vocals. Score for an animated middle school comedy. ${job.cue.prompt}`;
      const t0 = performance.now();
      try {
        const result = await lyria.generate(prompt, { model });
        writeFileSync(file, result.audioBytes);
        console.log(`${file}  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      } catch (error: any) {
        console.error(`${file}  FAILED  ${error?.message ?? error}`);
      }
    }
  })
);
