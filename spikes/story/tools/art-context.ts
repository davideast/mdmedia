// Throwaway: redraws selected comic panels with scene context, to compare.
//
//   bun spikes/story/tools/art-context.ts B <comic.json> <panels.json> <art-context.json> <base art dir> <out dir>
//   bun spikes/story/tools/art-context.ts C ...same...
//
// B: each panel gets an acting note written in context, plus its own and the
//    previous panel's dialogue as context. One reference: the character sheet.
// C: B, plus a staging image for the scene, the screen-side rule, previous
//    panels as references, edit chains for sequences of close-ups, and a
//    yes/no vision check after each panel with up to two redraws.
// The out dir starts as a copy of the base art dir so the page has every panel.

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const [mode, comicPath, charsPath, contextPath, baseDir, outDir, model = 'gemini-3-pro-image'] = Bun.argv.slice(2);
if ((mode !== 'B' && mode !== 'C') || !comicPath || !charsPath || !contextPath || !baseDir || !outDir) {
  console.error('usage: bun spikes/story/tools/art-context.ts <B|C> <comic.json> <panels.json> <art-context.json> <base art dir> <out dir> [model]');
  process.exit(2);
}

const STYLE = 'Modern middle-grade graphic novel art: clean confident ink outlines, flat bright colors with soft cel shading, expressive cartoon faces and body language';
const BLEED = 'One full-bleed illustration that fills the whole image edge to edge: no border, frame, boxes, panels or blank areas. No text anywhere: no speech balloons, captions, sound effects or lettering.';

interface Item { kind: string; who?: string; text: string }
interface Panel { id: number; aspect: string; note: string; positions: Record<string, string>; items: Item[] }
interface Direction { acting: string; refs?: string[]; edit?: string; check: string[] }
const comic = JSON.parse(readFileSync(comicPath, 'utf8')) as { panels: Panel[] };
const { characters } = JSON.parse(readFileSync(charsPath, 'utf8')) as { characters: Record<string, string> };
const ctx = JSON.parse(readFileSync(contextPath, 'utf8')) as { scene: string; staging: string; rules: string; panels: Record<string, Direction> };
const ai = new GoogleGenAI({ apiKey: readFileSync(join(homedir(), '.config', 'mdmedia', 'gemini-key'), 'utf8').trim() });

if (!existsSync(join(outDir, 'sheet.png'))) cpSync(baseDir, outDir, { recursive: true });
const file = (name: string) => join(outDir, name === 'sheet' || name === 'staging' ? `${name}.png` : `panel-${name.padStart(2, '0')}.png`);
const png = (path: string) => ({ inlineData: { mimeType: 'image/png', data: readFileSync(path).toString('base64') } });

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error: any) {
      if (attempt < 4 && ([429, 500, 503].includes(error?.status) || /aborted|fetch failed|no image/i.test(error?.message ?? ''))) { await Bun.sleep(3000 * 2 ** attempt); continue; }
      throw error;
    }
  }
}

async function draw(prompt: string, refs: string[], aspectRatio: string): Promise<Buffer> {
  return retry(async () => {
    const r = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [...refs.map((p) => png(p)), { text: prompt }] }],
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize: '1K' }, httpOptions: { timeout: 240_000 } } as any,
    });
    const data = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new Error('no image');
    return Buffer.from(data, 'base64');
  });
}

async function check(image: Buffer, questions: string[], previous?: string): Promise<boolean[]> {
  return retry(async () => {
    const r = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [{ role: 'user', parts: [
        ...(previous ? [{ text: 'Previous panel:' }, png(previous)] : []),
        { text: 'Panel to check:' },
        { inlineData: { mimeType: 'image/png', data: image.toString('base64') } },
        { text: `Character notes: ${Object.entries(characters).filter(([k]) => ['MILO', 'JUNE'].includes(k)).map(([, v]) => v).join(' ')}\nAnswer each question about the panel strictly, yes or no. Return JSON: an array of booleans in order.\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` },
      ] }],
      config: { responseMimeType: 'application/json' },
    });
    const answers = JSON.parse(r.text ?? '[]') as boolean[];
    return questions.map((_, i) => answers[i] === true);
  });
}

const report: Array<{ id: number; attempts: number; answers: boolean[]; questions: string[] }> = [];
const order = comic.panels.filter((p) => ctx.panels[p.id]);
const dialogue = (p?: Panel) => (p ? p.items.filter((i) => i.kind !== 'sfx').map((i) => (i.kind === 'caption' ? `(Milo narrating) "${i.text}"` : `${i.who} says "${i.text}"`)).join(' ') : '');

// Every C check also asks whether the characters are on model, because a
// drifted reference (the staging image) spreads to every panel drawn from it.
const ON_MODEL = [
  'If June appears: does she have straight black hair cut in a chin-length bob with blunt bangs (not long hair)?',
  'If Milo appears: does he have messy curly brown hair, freckles, a forest-green hoodie, blue jeans and red sneakers?',
  // Dialogue passed as context can leak onto the page as drawn balloons.
  'Is the image free of speech balloons, captions and written words (apart from school banners or signs)?',
];
// ONLY=35,36 redraws just those panels.
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;

// C: one staging image for the scene, drawn against the character sheet and
// checked against it before anything is drawn from it.
if (mode === 'C' && !existsSync(file('staging'))) {
  let tries = 0;
  for (;;) {
    tries++;
    const img = await draw(`${STYLE}. ${BLEED} ${ctx.staging} Characters, drawn exactly as in the reference sheet: ${characters.JUNE}; ${characters.MILO}. Both sit calmly with their lunches.`, [file('sheet')], '16:9');
    const answers = await check(img, ON_MODEL);
    if (answers.every(Boolean) || tries >= 4) { writeFileSync(file('staging'), img); console.log(`staging drawn in ${tries}, on model: ${answers.join(' ')}`); break; }
  }
}

for (const panel of order) {
  if (only && !only.has(panel.id)) continue;
  const dir = ctx.panels[panel.id]!;
  const index = comic.panels.findIndex((p) => p.id === panel.id);
  const previous = comic.panels[index - 1];
  const who = Object.keys(panel.positions).filter((k) => characters[k]).map((k) => characters[k]).join('; ');
  const context = `Story context: ${ctx.scene} In this panel: ${dialogue(panel) || 'no dialogue'}. Just before: ${dialogue(previous) || 'nothing'}. Draw the moment; do not write any of these words.`;

  let prompt: string;
  let refs: string[];
  if (mode === 'C' && dir.edit) {
    prompt = `Edit this comic panel. ${dir.acting} Keep everything else identical. ${BLEED}`;
    refs = [file(dir.edit)];
  } else {
    const refNames = mode === 'B' ? ['sheet'] : (dir.refs ?? ['sheet']).map((r) => (r === 'prev' ? String(previous!.id) : r));
    refs = refNames.map(file);
    const legend = refNames.map((r, i) => `reference ${i + 1} is ${r === 'sheet' ? 'the character sheet (match faces, hair and clothes exactly)' : r === 'staging' ? 'the staging of this scene (match the table, the seats and who sits where)' : 'an earlier panel of this scene (keep continuity with it)'}`).join('; ');
    prompt =
      `${STYLE}. ${BLEED} ${panel.note} ${dir.acting} ` +
      (mode === 'C' ? `${ctx.rules} ` : '') +
      `Characters: ${who}. ${context} Reference images: ${legend}.`;
  }

  let best: { img: Buffer; answers: boolean[] } | null = null;
  let attempts = 0;
  for (; attempts < (mode === 'C' ? 3 : 1); ) {
    attempts++;
    const img = await draw(prompt, refs, panel.aspect);
    const answers = mode === 'C' ? await check(img, [...dir.check, ...ON_MODEL], dir.edit ? file(dir.edit) : undefined) : [];
    if (!best || answers.filter(Boolean).length > best.answers.filter(Boolean).length) best = { img, answers };
    if (answers.every(Boolean)) break;
  }
  writeFileSync(file(String(panel.id)), best!.img);
  report.push({ id: panel.id, attempts, answers: best!.answers, questions: mode === 'C' ? [...dir.check, ...ON_MODEL] : dir.check });
  console.log(`${panel.id}  ${attempts} attempt(s)  ${best!.answers.map((a) => (a ? 'yes' : 'NO')).join(' ')}`);
}

writeFileSync(join(outDir, `context-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
