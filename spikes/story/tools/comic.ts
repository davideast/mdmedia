// Throwaway: parses a comic script (see embarrassing-day/comic-lunch.md) into
// comic.json for the reader and an art plan that tools/art.ts can draw.
//
//   bun spikes/story/tools/comic.ts <comic.md> <panels.json for characters> <out dir> [--pages 1,2]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
const PAGE_W = 1000;
const PAGE_H = 1500; // a 2:3 page, close to a trade paperback
const GUTTER = 14;

type Item =
  | { kind: 'caption'; text: string }
  | { kind: 'balloon'; who: string; text: string; tone: 'normal' | 'small' | 'off' }
  | { kind: 'sfx'; text: string };

interface Panel {
  id: number; // page * 10 + panel, so art files sort by page
  page: number;
  index: number;
  row: number;
  x: number; y: number; w: number; h: number; // slot on the page, in page units
  aspect: (typeof ASPECTS)[number];
  note: string;
  positions: Record<string, string>; // NAME -> left | center | right
  zone: 'top' | 'bottom';
  items: Item[];
}

const args = Bun.argv.slice(2);
const pagesArg = args.indexOf('--pages');
const onlyPages = pagesArg >= 0 ? new Set(args[pagesArg + 1]!.split(',').map(Number)) : null;
const [scriptPath, charactersPath, outDir] = args.filter((a, i) => !a.startsWith('--') && (pagesArg < 0 || i !== pagesArg + 1));
if (!scriptPath || !charactersPath || !outDir) {
  console.error('usage: bun spikes/story/tools/comic.ts <comic.md> <panels.json> <out dir> [--pages 1,2]');
  process.exit(2);
}

const source = readFileSync(scriptPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
if (!fm) throw new Error('missing front matter');
const meta = Bun.YAML.parse(fm[1]!) as { title: string; setting: string; style: string };
const body = source.slice(fm[0].length);

const nearestAspect = (ratio: number) =>
  ASPECTS.reduce((best, a) => {
    const [w, h] = a.split(':').map(Number) as [number, number];
    const [bw, bh] = best.split(':').map(Number) as [number, number];
    return Math.abs(Math.log(w / h / ratio)) < Math.abs(Math.log(bw / bh / ratio)) ? a : best;
  });

const panels: Panel[] = [];
const pages: Array<{ page: number; layout: number[][] }> = [];

for (const pageBlock of body.split(/^## Page /m).slice(1)) {
  const page = Number(pageBlock.match(/^(\d+)/)![1]);
  const layoutText = /^layout:\s*(.+)$/m.exec(pageBlock)?.[1] ?? '1';
  const layout = layoutText.split('|').map((row) => row.trim().split(/\s+/).map(Number));
  pages.push({ page, layout });

  // Slots: rows share the height equally; panels share a row by weight.
  const rowH = (PAGE_H - GUTTER * (layout.length + 1)) / layout.length;
  const slots: Array<{ row: number; x: number; y: number; w: number; h: number }> = [];
  layout.forEach((row, r) => {
    const total = row.reduce((a, b) => a + b, 0);
    const usable = PAGE_W - GUTTER * (row.length + 1);
    let x = GUTTER;
    for (const weight of row) {
      const w = (usable * weight) / total;
      slots.push({ row: r, x, y: GUTTER + r * (rowH + GUTTER), w, h: rowH });
      x += w + GUTTER;
    }
  });

  const panelBlocks = pageBlock.split(/^### Panel /m).slice(1);
  if (panelBlocks.length !== slots.length) {
    throw new Error(`page ${page}: layout has ${slots.length} slots but ${panelBlocks.length} panels`);
  }
  panelBlocks.forEach((panelBlock, i) => {
    const index = Number(panelBlock.match(/^(\d+)/)![1]);
    const paragraphs = panelBlock.replace(/^\d+\s*\n/, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let note = '';
    const items: Item[] = [];
    for (const p of paragraphs) {
      if (p.startsWith('>')) { note = p.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim(); continue; }
      const sfx = /^```sfx\n([\s\S]*?)\n```$/.exec(p);
      if (sfx) { items.push({ kind: 'sfx', text: sfx[1]!.trim() }); continue; }
      const balloon = /^\*\*([^*]+)\*\*\s*(?:\*\(([^)]*)\)\*)?\s*:\s*([\s\S]+)$/.exec(p);
      if (balloon) {
        const tone = balloon[2]?.trim() === 'small' ? 'small' : balloon[2]?.trim() === 'off' ? 'off' : 'normal';
        items.push({ kind: 'balloon', who: balloon[1]!.trim().toUpperCase(), text: balloon[3]!.replace(/\s+/g, ' ').trim(), tone });
        continue;
      }
      items.push({ kind: 'caption', text: p.replace(/\s+/g, ' ').trim() });
    }
    const positions: Record<string, string> = {};
    for (const m of note.matchAll(/\b(Left|Right|Center):\s*([A-Z]+(?:\s+and\s+[A-Z]+)?)\./g)) {
      for (const name of m[2]!.split(/\s+and\s+/)) positions[name] = m[1]!.toLowerCase();
    }
    const zone = /Balloons:\s*bottom/i.test(note) ? 'bottom' : 'top';
    const slot = slots[i]!;
    panels.push({
      id: page * 10 + index, page, index, row: slot.row,
      x: slot.x, y: slot.y, w: slot.w, h: slot.h,
      aspect: nearestAspect(slot.w / slot.h),
      note: note.replace(/\s*(Left|Right|Center):[^.]*\./g, '').replace(/\s*Balloons:[^.]*\./i, '').trim(),
      positions, zone, items,
    });
  });
}

const chosen = panels.filter((p) => !onlyPages || onlyPages.has(p.page));
const characters = JSON.parse(readFileSync(charactersPath, 'utf8')) as { characters: Record<string, string>; world: string };
mkdirSync(outDir, { recursive: true });

// Art plan in the shape tools/art.ts reads. The composition note keeps the
// balloon zone clear and puts each speaker where the balloons expect them.
const place = (p: Panel) =>
  Object.entries(p.positions)
    .filter(([name]) => characters.characters[name])
    .map(([name, where]) => `${name === 'MILO' ? 'Milo' : name === 'JUNE' ? 'June' : name === 'HARPER' ? 'Harper' : name} on the ${where === 'center' ? 'center' : where} of the frame`)
    .join(', ');
const art = {
  characters: characters.characters,
  world: characters.world,
  scenes: [{ from: 0, setting: meta.setting }],
  panels: chosen.map((p) => ({
    id: p.id,
    from: 0,
    aspect: p.aspect,
    shot:
      `${p.note}${place(p) ? ` Placement: ${place(p)}.` : ''} ` +
      `Framing: generous ${p.zone === 'top' ? 'headroom; the top quarter of the image shows only background scenery such as ceiling, wall or banners' : 'foot room; the bottom quarter shows only floor or table'}, with no faces there`,
    cast: Object.keys(p.positions).filter((n) => characters.characters[n]),
    text: [],
  })),
};

writeFileSync(join(outDir, 'art-plan.json'), JSON.stringify(art, null, 2) + '\n');
writeFileSync(
  join(outDir, 'comic.json'),
  JSON.stringify({ title: meta.title, style: meta.style, page: { w: PAGE_W, h: PAGE_H, gutter: GUTTER }, pages: pages.filter((p) => !onlyPages || onlyPages.has(p.page)), panels: chosen }, null, 2) + '\n'
);
console.log(`${chosen.length} panels on ${new Set(chosen.map((p) => p.page)).size} page(s) -> ${outDir}`);
for (const p of chosen) console.log(`  ${p.id}  ${p.aspect.padEnd(5)} ${Object.entries(p.positions).map(([n, w]) => `${n}:${w}`).join(' ')}  ${p.items.length} items`);
