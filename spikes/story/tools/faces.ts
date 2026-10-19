// Throwaway: finds where each named character's head is in each drawn panel,
// so lettering can avoid faces and point tails at the speaker.
// Writes faces.json: { "<panel id>": [{ name, box: [ymin, xmin, ymax, xmax] }] }
// with coordinates as fractions of the image (0..1).
//
//   bun spikes/story/tools/faces.ts <comic.json> <panels.json for characters> <art dir> [model]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const [comicPath, charactersPath, artDir, model = 'gemini-3.5-flash'] = Bun.argv.slice(2);
if (!comicPath || !charactersPath || !artDir) {
  console.error('usage: bun spikes/story/tools/faces.ts <comic.json> <panels.json> <art dir> [model]');
  process.exit(2);
}

interface Panel { id: number; positions: Record<string, string>; items: Array<{ kind: string; who?: string }> }
const comic = JSON.parse(readFileSync(comicPath, 'utf8')) as { panels: Panel[] };
const { characters } = JSON.parse(readFileSync(charactersPath, 'utf8')) as { characters: Record<string, string> };
const ai = new GoogleGenAI({ apiKey: readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim() });

const outPath = join(artDir, 'faces.json');
const faces: Record<string, Array<{ name: string; box: number[] }>> = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};

async function find(panel: Panel) {
  const file = join(artDir, `panel-${String(panel.id).padStart(2, '0')}.png`);
  const names = [...new Set([...Object.keys(panel.positions), ...panel.items.flatMap((i) => (i.who ? [i.who] : []))])];
  const known = names.filter((n) => characters[n]);
  if (!known.length) return [];
  const prompt =
    `Find the head of each of these characters in this comic panel, if visible:\n` +
    known.map((n) => `- ${n}: ${characters[n]}`).join('\n') +
    `\nReturn JSON: [{"name": NAME, "box_2d": [ymin, xmin, ymax, xmax]}] with coordinates 0-1000, ` +
    `one entry per character whose head is visible, the box tight around the head and hair. ` +
    `Ignore everyone else in the background.`;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: readFileSync(file).toString('base64') } }, { text: prompt }] }],
        config: { responseMimeType: 'application/json' },
      });
      const list = JSON.parse(r.text ?? '[]') as Array<{ name: string; box_2d: number[] }>;
      return list
        .filter((f) => known.includes(f.name?.toUpperCase()) && f.box_2d?.length === 4)
        .map((f) => ({ name: f.name.toUpperCase(), box: f.box_2d.map((v) => v / 1000) }));
    } catch (error: any) {
      if (attempt < 4 && [429, 500, 503].includes(error?.status)) { await Bun.sleep(3000 * 2 ** attempt); continue; }
      throw error;
    }
  }
}

const queue = comic.panels.filter((p) => !faces[p.id]);
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      faces[p.id] = await find(p);
      console.log(`${p.id}  ${faces[p.id]!.map((f) => `${f.name} [${f.box.map((v) => v.toFixed(2)).join(',')}]`).join('  ') || '(none)'}`);
    }
  })
);
writeFileSync(outPath, JSON.stringify(faces, null, 2) + '\n');
