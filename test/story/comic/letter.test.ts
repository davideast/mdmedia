import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import {
  letterPanel,
  overlapArea,
  panelHeads,
  tailPath,
  type HeadBox,
  type LetterItem,
  type LetterPanel,
  type Lettered,
  type Measure,
  type Rect,
} from '../../../src/story/comic/letter.js';

const dir = join(import.meta.dir, '..', 'fixtures');

/** Comic Neue bold capitals average about 0.6 em; Bangers about 0.55. */
const measure: Measure = (text, px, face) => text.length * px * (face === 'display' ? 0.55 : 0.6);

const panel = (items: LetterItem[], extra: Partial<LetterPanel> = {}): LetterPanel => ({
  id: '1.1',
  aspect: '1:1',
  positions: {},
  zone: 'top',
  items,
  ...extra,
});

const rects = (l: Lettered) => l.placed.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
const inside = (r: Rect, w: number, h: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6;

describe('panelHeads', () => {
  it('maps a head from a 16:9 image into a 1:1 panel that crops its sides', () => {
    const [head] = panelHeads([{ id: 'JUNE', box: [0.2, 0.45, 0.4, 0.55] }], '16:9', 900, 900);
    // The image is 1600 wide at this height; 350 px are cropped from each side.
    expect(head!.x).toBeCloseTo(0.45 * 1600 - 350);
    expect(head!.w).toBeCloseTo(160);
    expect(head!.y).toBeCloseTo(180);
  });

  it('drops a head that is cropped out of view', () => {
    expect(panelHeads([{ id: 'MILO', box: [0.3, 0.02, 0.5, 0.1] }], '16:9', 900, 900)).toEqual([]);
  });
});

describe('letterPanel', () => {
  const heads: HeadBox[] = [
    { id: 'JUNE', box: [0.3, 0.12, 0.55, 0.32] },
    { id: 'MILO', box: [0.32, 0.66, 0.56, 0.86] },
  ];
  const twoShot = panel(
    [
      { kind: 'caption', text: 'For one second, I thought she would laugh.' },
      { kind: 'balloon', who: 'JUNE', text: 'You sent my video?' },
      { kind: 'balloon', who: 'MILO', mark: 'small', text: 'It was just to Harper.' },
    ],
    { positions: { JUNE: 'left', MILO: 'right' } }
  );

  it('keeps every item off faces, off each other and inside the panel', () => {
    const l = letterPanel(twoShot, heads, 600, 600, measure, { fontPx: 20 });
    const faces = panelHeads(heads, '1:1', 600, 600);
    expect(l.crowded).toEqual([]);
    for (const r of rects(l)) {
      expect(inside(r, 600, 600)).toBe(true);
      for (const f of faces) expect(overlapArea(r, f)).toBe(0);
    }
    const all = rects(l);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlapArea(all[i]!, all[j]!)).toBe(0);
  });

  it('keeps reading order: each item starts below the one before, or to its right', () => {
    const l = letterPanel(twoShot, heads, 600, 600, measure, { fontPx: 20 });
    for (let i = 1; i < l.placed.length; i++) {
      const a = l.placed[i - 1]!;
      const b = l.placed[i]!;
      expect(b.y >= a.y + a.h * 0.6 || b.x >= a.x + a.w).toBe(true);
    }
  });

  it('puts a caption in the top left when it is free', () => {
    const l = letterPanel(twoShot, heads, 600, 600, measure, { fontPx: 20 });
    expect(l.placed[0]!.kind).toBe('caption');
    expect(l.placed[0]!.x).toBeLessThan(60);
    expect(l.placed[0]!.y).toBeLessThan(60);
  });

  it("ends a balloon's tail just outside its speaker's head", () => {
    const l = letterPanel(twoShot, heads, 600, 600, measure, { fontPx: 20 });
    const [june] = panelHeads(heads, '1:1', 600, 600);
    const tip = l.placed.find((p) => p.who === 'JUNE')!.tail!.tip;
    const dx = Math.max(june!.x - tip.x, 0, tip.x - (june!.x + june!.w));
    const dy = Math.max(june!.y - tip.y, 0, tip.y - (june!.y + june!.h));
    const distance = Math.hypot(dx, dy);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(15);
    expect(tailPath(l.placed[1]!.tail!)).toStartWith('M ');
  });

  it('points an off-panel tail at the panel edge', () => {
    const l = letterPanel(panel([{ kind: 'balloon', who: 'HARPER', mark: 'off', text: 'Milo! Dude!' }]), [], 600, 400, measure, { fontPx: 20 });
    expect([0, 600]).toContain(l.placed[0]!.tail!.tip.x);
  });

  it('points the tail of a speaker who is not drawn in the panel out of the frame', () => {
    const l = letterPanel(
      panel([{ kind: 'balloon', who: 'AKARI', text: 'You can talk.' }], { positions: { TAMA: 'center' } }),
      [{ id: 'TAMA', box: [0.55, 0.4, 0.72, 0.6] }],
      600,
      600,
      measure,
      { fontPx: 20 }
    );
    expect([0, 600]).toContain(l.placed[0]!.tail!.tip.x);
  });

  it('fits every line of a balloon inside its oval', () => {
    const l = letterPanel(panel([{ kind: 'balloon', who: 'FUJI', text: "Everything you'd like to forget is tied to something you love. He takes both." }]), [], 600, 600, measure, { fontPx: 20 });
    const s = l.placed[0]!.shapes[0]!;
    const lh = 20 * 1.18;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    s.lines.forEach((line, i) => {
      const half = measure(line, 20, 'letter') / 2;
      for (const y of [cy - (s.lines.length * lh) / 2 + i * lh, cy - (s.lines.length * lh) / 2 + (i + 1) * lh]) {
        expect((half / (s.w / 2)) ** 2 + ((y - cy) / (s.h / 2)) ** 2).toBeLessThanOrEqual(1);
      }
      expect(cx).toBeGreaterThan(0);
    });
  });

  it('does not stack a long balloon into a tall sliver in a narrow panel (adapted lunch, panel 1.3)', () => {
    const text = "You're definitely one of my favorites. That clip? Hilarious. We're using it in the assembly.";
    const l = letterPanel(panel([{ kind: 'balloon', who: 'HARPER', text }], { aspect: '9:16' }), [], 300, 640, measure, { fontPx: 16 });
    const s = l.placed[0]!.shapes[0]!;
    expect(s.h).toBeLessThanOrEqual(s.w * 1.15);
  });

  it("points at a speaker whose face the art shows, even when the script marked them off panel", () => {
    const l = letterPanel(
      panel([{ kind: 'balloon', who: 'MILO', mark: 'off', text: 'I know, but--' }], { positions: { JUNE: 'left' } }),
      [{ id: 'MILO', box: [0.4, 0.62, 0.62, 0.8] }],
      600,
      600,
      measure,
      { fontPx: 20 }
    );
    const tip = l.placed[0]!.tail!.tip;
    expect(tip.x).toBeGreaterThan(0.55 * 600);
    expect(tip.x).toBeLessThan(600);
  });

  it('joins two balloons in a row by one speaker', () => {
    const l = letterPanel(
      panel([
        { kind: 'balloon', who: 'HARPER', text: 'You are definitely one of my favorites.' },
        { kind: 'balloon', who: 'HARPER', text: 'That clip? Hilarious.' },
      ]),
      [],
      600,
      600,
      measure,
      { fontPx: 20 }
    );
    expect(l.placed).toHaveLength(1);
    expect(l.placed[0]!.items).toEqual([0, 1]);
    expect(l.placed[0]!.shapes).toHaveLength(2);
  });

  it('puts a balloon below its speaker when the art leaves no headroom', () => {
    const l = letterPanel(
      panel([{ kind: 'balloon', who: 'JUNE', text: 'What clip?' }], { positions: { JUNE: 'center' } }),
      [{ id: 'JUNE', box: [0.02, 0.1, 0.45, 0.9] }],
      600,
      600,
      measure,
      { fontPx: 20 }
    );
    const b = l.placed[0]!;
    expect(b.y).toBeGreaterThanOrEqual(0.45 * 600);
    expect(b.tail!.tip.y).toBeGreaterThan(0.45 * 600);
  });

  it('shrinks the lettering to the minimum on an impossible panel and reports what is crowded', () => {
    const text = 'This is far too much to say in such a tiny panel with a face filling nearly all of it, so something must give.';
    const l = letterPanel(panel([{ kind: 'caption', text }, { kind: 'caption', text }]), [{ id: 'X', box: [0.1, 0.1, 0.9, 0.9] }], 200, 200, measure, {
      fontPx: 20,
      minFontPx: 12,
    });
    expect(l.fontPx).toBe(12);
    expect(l.crowded.length).toBeGreaterThan(0);
  });

  it('never changes the text, only wraps it', () => {
    const l = letterPanel(twoShot, heads, 600, 600, measure, { fontPx: 20 });
    for (const p of l.placed) {
      p.items.forEach((i, k) => {
        expect(p.shapes[k]!.lines.join(' ')).toBe((twoShot.items[i] as { text: string }).text.toUpperCase());
      });
    }
  });
});

describe('the fixture comics, with head boxes from their live draws', async () => {
  const comics = [
    ['comic-lunch', 'embarrassing-day'],
    ['comic-midnight-line', 'midnight-line'],
    ['comic-wren-backwards', 'wren-backwards'],
  ] as const;
  for (const [name, storyName] of comics) {
    const cast = (await parseStory(readFileSync(join(dir, `${storyName}.md`), 'utf8'), { path: 's.md' })).script!.cast;
    const comic = (await parseComic(readFileSync(join(dir, `${name}.md`), 'utf8'), { path: 'c.md', cast })).comic!;
    const heads = JSON.parse(readFileSync(join(dir, 'heads', `${name}.json`), 'utf8')) as Record<string, HeadBox[]>;
    const panels = comic.pages.flatMap((p) => p.panels);

    for (const [view, scaleOf, options] of [
      ['page', () => 1, { fontPx: 20 }],
      ['guided at 390 px', (w: number) => 390 / w, { fontPx: 0, minFontPx: 15 }],
    ] as const) {
      it(`${name}: ${view}, no lettering over a face, at most 2 crowded panels`, () => {
        let crowdedPanels = 0;
        for (const p of panels) {
          const k = scaleOf(p.slot.w);
          const w = p.slot.w * k;
          const h = p.slot.h * k;
          const fontPx = Math.max(options.fontPx || 20 * k, options.minFontPx ?? 0);
          const l = letterPanel(p, heads[p.id] ?? [], w, h, measure, { fontPx, minFontPx: options.minFontPx ?? fontPx * 0.7 });
          if (l.crowded.length) {
            crowdedPanels++;
            continue;
          }
          const faces = panelHeads(heads[p.id] ?? [], p.aspect, w, h);
          for (const r of rects(l)) for (const f of faces) expect(overlapArea(r, f)).toBe(0);
        }
        expect(crowdedPanels).toBeLessThanOrEqual(2);
      });
    }
  }
});
