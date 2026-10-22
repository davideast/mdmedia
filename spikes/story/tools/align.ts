// Throwaway: asks Gemini where each scripted line starts in a render, then
// rewrites the timeline with those times. Writes into a copy of the render dir.
//
//   bun spikes/story/tools/align.ts <render dir> <out dir> [model]

import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const [dir, outDir, model = 'gemini-3.5-flash'] = Bun.argv.slice(2);
if (!dir || !outDir) { console.error('usage: bun spikes/story/tools/align.ts <render dir> <out dir> [model]'); process.exit(2); }

cpSync(dir, outDir, { recursive: true });
const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { durationMs: number; lines: Array<{ text: string; speaker: string; startMs: number; endMs: number }> };
const wav = readFileSync(join(dir, 'master.wav'));

const prompt =
  `This recording performs the numbered script lines below, in order. For each line, give the time in seconds ` +
  `(two decimals) where its first word starts and where its last word ends. Return JSON: ` +
  `[{"line": n, "start": s, "end": e}] for every line.\n\n` +
  timeline.lines.map((l, i) => `${i + 1}. ${l.speaker}: ${l.text}`).join('\n');

const ai = new GoogleGenAI({ apiKey: readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim() });
let times: Array<{ line: number; start: number; end: number }> = [];
for (let attempt = 0; ; attempt++) {
  try {
    const r = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }, { text: prompt }] }],
      config: { responseMimeType: 'application/json' },
    });
    times = JSON.parse(r.text ?? '[]');
    break;
  } catch (error: any) {
    if (attempt < 4 && [429, 500, 503].includes(error?.status)) { await Bun.sleep(3000 * 2 ** attempt); continue; }
    throw error;
  }
}

const byLine = new Map(times.map((t) => [t.line, t]));
let moved = 0;
timeline.lines.forEach((l, i) => {
  const t = byLine.get(i + 1);
  if (!t || !(t.end > t.start)) return;
  // A little air on both sides, never overlapping the neighbours.
  l.startMs = Math.max(0, Math.round(t.start * 1000) - 80);
  l.endMs = Math.min(timeline.durationMs, Math.round(t.end * 1000) + 120);
  moved++;
});
timeline.lines.forEach((l, i) => {
  const next = timeline.lines[i + 1];
  if (next && l.endMs > next.startMs) l.endMs = next.startMs;
});
writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
console.log(`${moved}/${timeline.lines.length} lines aligned -> ${outDir}`);
