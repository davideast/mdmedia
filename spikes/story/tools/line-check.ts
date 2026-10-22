// Throwaway: cuts every line out of a render at its timeline boundaries,
// transcribes all of them in one request, and compares each with its text.
// Catches spoken cues, dropped or repeated words, and cuts in the wrong place.
//
//   bun spikes/story/tools/line-check.ts <render dir> [model]

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const [dir, model = 'gemini-3.5-flash-lite'] = Bun.argv.slice(2);
if (!dir) { console.error('usage: bun spikes/story/tools/line-check.ts <render dir> [model]'); process.exit(2); }

const RATE = 24000;
const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { lines: Array<{ id: number; speaker: string; text: string; startMs: number; endMs: number }> };
const pcm = readFileSync(join(dir, 'master.wav')).subarray(44);

function wavOf(startMs: number, endMs: number): Buffer {
  const a = Math.max(0, Math.round((startMs * RATE) / 1000)) * 2;
  const b = Math.min(pcm.length, Math.round((endMs * RATE) / 1000) * 2);
  const body = pcm.subarray(a, b);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + body.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(body.length, 40);
  return Buffer.concat([h, body]);
}

// One request per clip: batching clips in one request made the model drift
// by a clip and merge neighbours.
const ai = new GoogleGenAI({ apiKey: readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim() });
async function transcribe(startMs: number, endMs: number): Promise<string> {
  if (endMs - startMs < 150) return '(empty clip)';
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'audio/wav', data: wavOf(startMs, endMs).toString('base64') } },
          { text: 'Transcribe this clip verbatim, exactly as spoken, including any words that sound like stage directions or speaker names. Reply with the words only; reply with nothing if there is no speech.' },
        ] }],
      });
      return (r.text ?? '').trim();
    } catch (error: any) {
      if (attempt < 4 && [429, 500, 503].includes(error?.status)) { await Bun.sleep(2000 * 2 ** attempt); continue; }
      throw error;
    }
  }
}
const heard: string[] = new Array(timeline.lines.length);
const queue = timeline.lines.map((l, i) => ({ l, i }));
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) heard[job.i] = await transcribe(job.l.startMs, job.l.endMs);
}));

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function compare(want: string[], got: string[]) {
  // Longest common subsequence, to name missing and extra words.
  const dp = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) for (let j = got.length - 1; j >= 0; j--)
    dp[i]![j] = want[i] === got[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const missing: string[] = [], extra: string[] = [];
  let i = 0, j = 0;
  while (i < want.length && j < got.length) {
    if (want[i] === got[j]) { i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) missing.push(want[i++]!); else extra.push(got[j++]!);
  }
  missing.push(...want.slice(i)); extra.push(...got.slice(j));
  return { missing, extra };
}

const results = timeline.lines.map((l, i) => {
  const got = heard[i] ?? '';
  const { missing, extra } = compare(words(l.text), words(got));
  return { id: l.id, speaker: l.speaker, text: l.text, heard: got, missing, extra, ok: missing.length === 0 && extra.length === 0 };
});
writeFileSync(join(dir, 'line-check.json'), JSON.stringify({ model, results }, null, 2) + '\n');
const bad = results.filter((r) => !r.ok);
console.log(`${dir}: ${results.length - bad.length}/${results.length} lines match`);
for (const r of bad) console.log(`  ${r.id} ${r.speaker}: "${r.text}"\n     heard "${r.heard}"  missing [${r.missing.join(' ')}] extra [${r.extra.join(' ')}]`);
