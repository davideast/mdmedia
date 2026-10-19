// Throwaway: draws a character sheet, then every panel in panels.json with the
// sheet as a reference image, in one named style.
//
//   bun spikes/story/tools/art.ts <panels.json> <out dir> <style> [model] [--letter]
//
// Without --letter the art has no text; the page letters it. With --letter the
// model draws the bubbles and captions itself, to compare.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { generateGeminiImage, type ImageAspectRatio } from '../../../src/image/index.js';

const STYLES: Record<string, string> = {
  flat:
    'Modern middle-grade graphic novel art: clean confident ink outlines, flat bright colors with soft cel shading, ' +
    'expressive cartoon faces and body language, warm and funny',
  watercolor:
    'Hand-drawn picture-book illustration: loose pen-and-ink linework with transparent watercolor washes, ' +
    'visible paper texture, soft warm palette, gentle and charming',
  manga:
    'Black-and-white manga: crisp inked lines, screentone shading, dynamic camera angles, ' +
    'big expressive manga reactions, speed lines for motion',
};

const args = Bun.argv.slice(2);
const letter = args.includes('--letter');
const [panelsPath, outDir, style, model = 'gemini-3-pro-image'] = args.filter((a) => !a.startsWith('--'));
if (!panelsPath || !outDir || !style || !STYLES[style]) {
  console.error(`usage: bun spikes/story/tools/art.ts <panels.json> <out dir> <${Object.keys(STYLES).join('|')}> [model] [--letter]`);
  process.exit(2);
}

interface Text { kind: 'caption' | 'bubble' | 'sfx' | 'phone'; who?: string; text: string }
interface Panel { id: number; aspect: ImageAspectRatio; shot: string; cast: string[]; text: Text[] }
const plan = JSON.parse(readFileSync(panelsPath, 'utf8')) as {
  characters: Record<string, string>;
  world: string;
  scenes: Array<{ from: number; setting: string }>;
  panels: Array<Panel & { from: number }>;
};
const settingFor = (from: number) => [...plan.scenes].reverse().find((s) => s.from <= from)?.setting ?? '';

const key = process.env.GEMINI_API_KEY ?? readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim();
const client = new GoogleGenAI({ apiKey: key });
mkdirSync(outDir, { recursive: true });

const report: Array<{ file: string; ms: number; ok: boolean; error?: string }> = [];

async function draw(file: string, prompt: string, aspectRatio: ImageAspectRatio, reference?: Uint8Array) {
  if (existsSync(file)) return;
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const image = await generateGeminiImage(client, {
        prompt,
        model,
        aspectRatio,
        resolution: '1K',
        ...(reference ? { reference: { bytes: reference, mimeType: 'image/png' } } : {}),
      });
      writeFileSync(file, image.bytes);
      report.push({ file, ms: Math.round(performance.now() - t0), ok: true });
      console.log(`${file}  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      return;
    } catch (error: any) {
      const status = error?.status ?? error?.code;
      const retryable = [429, 500, 503].includes(status) || /no image|timeout|fetch failed/i.test(error?.message ?? '');
      if (attempt < 4 && retryable) { await Bun.sleep(3000 * 2 ** attempt); continue; }
      report.push({ file, ms: Math.round(performance.now() - t0), ok: false, error: String(error?.message ?? error).slice(0, 300) });
      console.error(`${file}  FAILED  ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
  }
}

// 1. Character sheet: the reference every panel is drawn against.
const sheet = join(outDir, 'sheet.png');
const lineup = ['MILO', 'JUNE', 'HARPER', 'ALVAREZ', 'TECHKID'].map((k) => plan.characters[k]).join('; ');
await draw(
  sheet,
  `${STYLES[style]}. A character reference sheet on a plain light background: five characters standing side by side, ` +
    `full body, front view, neutral friendly poses, evenly spaced, no text or labels. From left to right: ${lineup}.`,
  '16:9'
);
if (!existsSync(sheet)) throw new Error('no character sheet; stopping');
const reference = new Uint8Array(readFileSync(sheet));

// 2. Panels, four at a time.
const queue = [...plan.panels];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let panel = queue.shift(); panel; panel = queue.shift()) {
      const who = panel.cast.map((k) => plan.characters[k]).join('; ');
      const lettering = letter
        ? 'Letter this panel like a printed comic: ' +
          panel.text
            .map((t) =>
              t.kind === 'caption'
                ? `a rectangular yellow caption box reading "${t.text}"`
                : t.kind === 'sfx'
                  ? `a bold sound effect reading "${t.text}"`
                  : t.kind === 'phone'
                    ? `a phone screen showing a text message from ${t.who === 'ME' ? 'Milo' : t.who} reading "${t.text}"`
                    : `a speech bubble from ${t.who} reading "${t.text}"`
            )
            .join('; ') +
          '. Spell every word exactly.'
        : 'No text anywhere: no speech bubbles, captions, sound effects, signs or writing.';
      const prompt =
        `${STYLES[style]}. One comic panel. ${panel.shot}. ` +
        (who ? `Characters, drawn exactly as in the reference sheet: ${who}. ` : '') +
        `Setting, unless the shot says otherwise: ${settingFor(panel.from)}, at ${plan.world}. ${lettering}`;
      await draw(join(outDir, `panel-${String(panel.id).padStart(2, '0')}.png`), prompt, panel.aspect, reference);
    }
  })
);

writeFileSync(join(outDir, 'report.json'), JSON.stringify({ style, model, letter, report }, null, 2) + '\n');
console.log(`${report.filter((r) => r.ok).length} drawn, ${report.filter((r) => !r.ok).length} failed`);
