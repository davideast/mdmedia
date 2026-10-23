import type { Slot } from './types.js';

/** A 2:3 page, close to a trade paperback, in page units. */
export const PAGE = { width: 1000, height: 1500, gutter: 14 } as const;

/** The aspect ratios the image model draws. */
export const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

/** Panel slots for a layout: rows share the height, panels share a row by weight. */
export function layoutSlots(layout: number[][], page: { width: number; height: number; gutter: number } = PAGE): Slot[] {
  const rowH = (page.height - page.gutter * (layout.length + 1)) / layout.length;
  const slots: Slot[] = [];
  layout.forEach((row, r) => {
    const total = row.reduce((a, b) => a + b, 0);
    const usable = page.width - page.gutter * (row.length + 1);
    let x = page.gutter;
    for (const weight of row) {
      const w = (usable * weight) / total;
      slots.push({ x, y: page.gutter + r * (rowH + page.gutter), w, h: rowH });
      x += w + page.gutter;
    }
  });
  return slots;
}

/** The supported aspect ratio closest to a width:height ratio. */
export function nearestAspect(ratio: number): string {
  let best: string = ASPECTS[0];
  let bestDistance = Infinity;
  for (const aspect of ASPECTS) {
    const [w, h] = aspect.split(':').map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h / ratio));
    if (distance < bestDistance) { best = aspect; bestDistance = distance; }
  }
  return best;
}

/** `1 | 1 1 | 2 1` → [[1], [1, 1], [2, 1]]; undefined when it is not a layout. */
export function parseLayout(text: string): number[][] | undefined {
  const rows = text.split('|').map((row) => row.trim().split(/\s+/).map(Number));
  if (!rows.length || rows.some((row) => !row.length || row.some((n) => !(n > 0)))) return undefined;
  return rows;
}
