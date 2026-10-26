/**
 * Lettering: where captions, balloons and sound effects go on a drawn panel.
 *
 * Pure layout with no DOM, so the reader runs this same code in the browser
 * (with canvas text measurement) and tests run it with a fixed-width measure.
 * Everything lives inside `lettering()`, which uses nothing from outside it,
 * so the reader inlines its source as it is: no bundler.
 *
 * Code owns lettering and the model owns positions (prototype run 4): head
 * boxes from a vision pass keep every item off faces, and tails end just short
 * of the speaker's head.
 */

/** A rectangle in panel pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Head extends Rect {
  id: string;
}

/** What letterPanel needs from a comic panel. */
export interface LetterPanel {
  id: string;
  /** The aspect the art was drawn at, such as `16:9`; shown cropped to the panel. */
  aspect: string;
  positions: Record<string, 'left' | 'center' | 'right'>;
  zone: 'top' | 'bottom';
  items: LetterItem[];
}

export type LetterItem =
  | { kind: 'caption'; text: string }
  | { kind: 'balloon'; who: string; mark?: 'small' | 'off' | 'loud'; text: string }
  | { kind: 'sfx'; text: string };

/** Head boxes as fractions of the drawn image: [ymin, xmin, ymax, xmax]. */
export interface HeadBox {
  id: string;
  box: [number, number, number, number];
}

/** Width in pixels of one line of lettering, already uppercase. */
export type Measure = (text: string, fontPx: number, face: 'letter' | 'display') => number;

export interface LetterOptions {
  /** Lettering size; the page view uses 2% of the page width (prototype run 4). */
  fontPx: number;
  /** The smallest size the lettering may shrink to when a panel is crowded. */
  minFontPx?: number;
}

/** One oval or box of text. */
export interface Shape extends Rect {
  lines: string[];
}

export interface Tail {
  /** The middle of the tail's base, on the balloon's edge. */
  base: { x: number; y: number };
  tip: { x: number; y: number };
  /** Half the base width. */
  half: number;
}

export interface Placed extends Rect {
  /** The item's index in the panel; a joined balloon lists every item it holds. */
  items: number[];
  kind: 'caption' | 'balloon' | 'sfx';
  mark?: 'small' | 'off' | 'loud';
  who?: string;
  fontPx: number;
  shapes: Shape[];
  tail?: Tail;
}

export interface Lettered {
  placed: Placed[];
  /** Item indexes that could not be placed clear of faces and other items. */
  crowded: number[];
  fontPx: number;
}

/** The layout, self-contained so its source can run in the reader. */
export function lettering() {
  /** Line height, padding and spacing, in ems of the lettering size. */
  const LETTERING = {
    lineHeight: 1.18,
    captionPad: { x: 0.55, y: 0.35 },
    balloonPad: { x: 1.15, y: 0.8 },
    smallScale: 0.8,
    sfxScale: 2.8,
    /** An oval taller than this times its width is rewrapped wider. */
    maxOvalTallness: 1.1,
    shrink: 0.9,
  } as const;

  /** Where a speaker's side of the frame is, as a fraction of the width. */
  const SIDE = { left: 0.22, center: 0.5, right: 0.78 } as const;

  /**
   * Maps head boxes from the drawn image into the panel, which shows the image
   * cropped to cover it. A head with less than a third of it in view is dropped.
   */
  function panelHeads(heads: HeadBox[], aspect: string, w: number, h: number): Head[] {
    const [aw, ah] = aspect.split(':').map(Number) as [number, number];
    const scale = Math.max(w / aw, h / ah);
    const iw = aw * scale;
    const ih = ah * scale;
    const dx = (w - iw) / 2;
    const dy = (h - ih) / 2;
    const out: Head[] = [];
    for (const { id, box } of heads) {
      const [y0, x0, y1, x1] = box;
      const full = { x: dx + x0 * iw, y: dy + y0 * ih, w: (x1 - x0) * iw, h: (y1 - y0) * ih };
      const seen = clip(full, { x: 0, y: 0, w, h });
      if (full.w <= 0 || full.h <= 0 || area(seen) < area(full) / 3) continue;
      out.push({ id, ...seen });
    }
    return out;
  }

  /** Greedy word wrap to a width. A word wider than the width gets its own line. */
  function wrap(text: string, maxWidth: number, fontPx: number, measure: Measure, face: 'letter' | 'display' = 'letter'): string[] {
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, fontPx, face) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Letters one panel of `w` by `h` pixels. Items go in reading order, each in
   * the highest free spot after the one before; never over a head or another
   * item. If something can't fit, the whole panel's lettering shrinks a step at a
   * time to `minFontPx`, and what still doesn't fit goes where it covers least
   * and is reported as crowded.
   */
  function letterPanel(panel: LetterPanel, heads: HeadBox[], w: number, h: number, measure: Measure, options: LetterOptions): Lettered {
    const inPanel = panelHeads(heads, panel.aspect, w, h);
    const min = Math.min(options.minFontPx ?? options.fontPx * 0.7, options.fontPx);
    let fontPx = options.fontPx;
    for (;;) {
      const attempt = layout(panel, inPanel, w, h, measure, fontPx, false);
      if (attempt) return { placed: attempt, crowded: [], fontPx };
      const next = fontPx * LETTERING.shrink;
      if (next < min - 1e-9) break;
      fontPx = next;
    }
    fontPx = min;
    const placed = layout(panel, inPanel, w, h, measure, fontPx, true)!;
    const crowded = placed.filter((p) => (p as Placed & { crowded?: boolean }).crowded).flatMap((p) => p.items);
    for (const p of placed) delete (p as Placed & { crowded?: boolean }).crowded;
    return { placed, crowded, fontPx };
  }

  /** Consecutive balloons by one speaker go in one joined group. */
  function groups(items: LetterItem[]): number[][] {
    const out: number[][] = [];
    items.forEach((item, i) => {
      const last = out.at(-1);
      const prev = last ? items[last.at(-1)!] : undefined;
      if (last && item.kind === 'balloon' && prev?.kind === 'balloon' && prev.who === item.who && prev.mark === item.mark) last.push(i);
      else out.push([i]);
    });
    return out;
  }

  function layout(panel: LetterPanel, heads: Head[], w: number, h: number, measure: Measure, fontPx: number, force: boolean): Placed[] | undefined {
    const pad = w * 0.025;
    const gap = Math.max(w, h) * 0.015;
    const keepOut = heads.map((k) => ({ x: k.x - w * 0.01, y: k.y - h * 0.02, w: k.w + w * 0.02, h: k.h + h * 0.03 }));
    const placed: Array<Placed & { crowded?: boolean }> = [];
    let prev: Rect | undefined;

    for (const group of groups(panel.items)) {
      const first = panel.items[group[0]!]!;
      const sized = size(panel, group, w, h, measure, fontPx);
      const head = first.kind === 'balloon' ? heads.find((k) => k.id === first.who) : undefined;
      const speakerX = first.kind === 'balloon' ? (head ? head.x + head.w / 2 : SIDE[panel.positions[first.who] ?? 'center'] * w) : 0;
      const bw = sized.w;
      const bh = sized.h;
      if (bw > w - 2 * pad || bh > h - 2 * pad) {
        if (!force) return undefined;
      }

      let best: { x: number; y: number; score: number; hit: number } | undefined;
      const stepX = w * 0.02;
      const stepY = h * 0.02;
      // Pass 0 keeps reading order; pass 1 lets it go; pass 2 (forced) allows overlap.
      for (let pass = 0; pass < (force ? 3 : 2) && !best; pass++) {
        for (let y = pad; y + bh <= h - pad + 1e-9 || (pass === 2 && y === pad); y += stepY) {
          for (let x = pad; x + bw <= w - pad + 1e-9 || (pass === 2 && x === pad); x += stepX) {
            const rect = { x, y, w: bw, h: bh };
            const itemHit = placed.reduce((n, q) => n + overlapArea(grow(q, gap), rect), 0);
            const faceHit = keepOut.reduce((n, k) => n + overlapArea(k, rect), 0);
            if (pass < 2 && (itemHit > 0 || faceHit > 0)) continue;
            if (pass === 0 && prev && first.kind !== 'sfx' && !follows(rect, prev, gap)) continue;
            let score: number;
            if (first.kind === 'sfx') score = Math.abs(y + bh / 2 - h * 0.45) / h;
            else {
              score = panel.zone === 'bottom' ? (h - y - bh) / h : y / h;
              if (first.kind === 'caption') score += (x / w) * 0.6;
              else {
                score += (Math.abs(x + bw / 2 - speakerX) / w) * 0.8;
                // Above or beside the speaker's head, below it only as a last resort.
                if (head && y + bh / 2 > head.y + head.h * 0.5) score += 0.6;
              }
            }
            const hit = (itemHit + faceHit) / (bw * bh);
            if (pass === 2) score += hit * 20;
            if (!best || score < best.score) best = { x, y, score, hit };
          }
        }
      }
      if (!best) return undefined;

      const dx = best.x - sized.x;
      const dy = best.y - sized.y;
      const shapes = sized.shapes.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
      const item: Placed & { crowded?: boolean } = {
        x: best.x,
        y: best.y,
        w: bw,
        h: bh,
        items: group,
        kind: first.kind,
        fontPx: sized.fontPx,
        shapes,
        ...(first.kind === 'balloon' ? { who: first.who, ...(first.mark ? { mark: first.mark } : {}) } : {}),
        ...(best.hit > 0 ? { crowded: true } : {}),
      };
      if (first.kind === 'balloon') item.tail = tail(shapes[0]!, first, head, panel, w, h);
      placed.push(item);
      if (first.kind !== 'sfx') prev = item;
    }
    return placed;
  }

  /** Below the item before, or beside it to the right in the same row. */
  function follows(rect: Rect, prev: Rect, gap: number): boolean {
    const below = rect.y >= prev.y + prev.h * 0.6;
    const beside = rect.y >= prev.y - rect.h * 0.4 && rect.x >= prev.x + prev.w + gap * 0.5;
    return below || beside;
  }

  /** The shapes of a group at the origin, and their bounding box. */
  function size(panel: LetterPanel, group: number[], w: number, h: number, measure: Measure, fontPx: number): Rect & { shapes: Shape[]; fontPx: number } {
    const first = panel.items[group[0]!]!;
    const wide = w > h * 1.3;
    // A narrow panel wraps wider, or its balloons turn into tall slivers down
    // the middle of the art (adapted lunch scene, panel 1.3).
    const narrow = w < h * 0.75;
    if (first.kind === 'sfx') {
      const px = fontPx * LETTERING.sfxScale;
      const lines = wrap(first.text, w * 0.5, px, measure, 'display');
      const sw = Math.max(...lines.map((l) => measure(l, px, 'display')));
      const sh = lines.length * px;
      return { x: 0, y: 0, w: sw, h: sh, fontPx: px, shapes: [{ x: 0, y: 0, w: sw, h: sh, lines }] };
    }
    const px = first.kind === 'balloon' && first.mark === 'small' ? fontPx * LETTERING.smallScale : fontPx;
    const padE = first.kind === 'caption' ? LETTERING.captionPad : LETTERING.balloonPad;
    const maxText = (wide ? 0.4 : narrow ? 0.86 : 0.62) * w - 2 * padE.x * px;
    const widest = 0.9 * w - 2 * padE.x * px;
    const shapes: Shape[] = [];
    let y = 0;
    let x = 0;
    for (const i of group) {
      const item = panel.items[i]!;
      let lines = balancedWrap(item.text, maxText, px, measure);
      let widths = lines.map((l) => measure(l, px, 'letter'));
      let { sw, sh } =
        first.kind === 'caption'
          ? { sw: Math.max(...widths) + 2 * padE.x * px, sh: lines.length * px * LETTERING.lineHeight + 2 * padE.y * px }
          : oval(widths, px);
      // A balloon taller than it is wide wraps wider, up to nearly the panel's width.
      if (first.kind === 'balloon' && sh > sw * LETTERING.maxOvalTallness && widest > maxText) {
        lines = wrap(item.text, widest, px, measure);
        widths = lines.map((l) => measure(l, px, 'letter'));
        ({ sw, sh } = oval(widths, px));
      }
      shapes.push({ x, y, w: sw, h: sh, lines });
      // A joined balloon steps down and a little right, overlapping slightly.
      y += sh * 0.88;
      x += sw * 0.12;
    }
    const bounds = shapes.reduce<Rect>((b, s) => union(b, s), shapes[0]!);
    return { ...bounds, fontPx: px, shapes };
  }

  /**
   * The smallest oval that holds every line inside it, corners included:
   * a box around the text pokes its long lines out of the ellipse.
   */
  function oval(widths: number[], px: number): { sw: number; sh: number } {
    const lh = px * LETTERING.lineHeight;
    const half = (widths.length * lh) / 2;
    let best = { sw: 0, sh: 0, area: Infinity };
    for (let k = 1.1; k <= 2.2; k += 0.05) {
      const ry = half * k + px * 0.2;
      let rx = 0;
      widths.forEach((width, i) => {
        // The line's edge farthest from the middle, top or bottom.
        const top = Math.abs(i * lh - half);
        const bottom = Math.abs((i + 1) * lh - half);
        const far = Math.max(top, bottom);
        rx = Math.max(rx, width / 2 / Math.sqrt(Math.max(0.05, 1 - (far / ry) ** 2)));
      });
      const area = rx * ry;
      if (area < best.area) best = { sw: 2 * rx + px * 0.9, sh: 2 * ry + px * 0.5, area };
    }
    return { sw: best.sw, sh: best.sh };
  }

  /** Wraps to the narrowest width that keeps the same number of lines, so balloons stay round. */
  function balancedWrap(text: string, maxWidth: number, fontPx: number, measure: Measure): string[] {
    const widest = wrap(text, maxWidth, fontPx, measure);
    const target = Math.max(1, Math.round(Math.sqrt(measure(text.toUpperCase(), fontPx, 'letter') / (fontPx * 2.4))));
    let best = widest;
    for (let width = maxWidth; width > fontPx * 3; width *= 0.92) {
      const lines = wrap(text, width, fontPx, measure);
      if (lines.length > Math.max(widest.length, target)) break;
      best = lines;
    }
    return best;
  }

  /** A tail from the balloon's edge toward the speaker, ending just short of the head. */
  function tail(shape: Rect, item: LetterItem & { kind: 'balloon' }, head: Head | undefined, panel: LetterPanel, w: number, h: number): Tail {
    const cx = shape.x + shape.w / 2;
    const cy = shape.y + shape.h / 2;
    let tip: { x: number; y: number };
    // Off panel: marked [off], or not drawn in this panel at all. The tail points
    // out of the frame, never at whoever happens to be in it.
    // When the art shows the speaker (their face was found), the tail points at
    // them, whatever the script marked.
    if (!head && (item.mark === 'off' || !panel.positions[item.who])) tip = { x: cx < w / 2 ? 0 : w, y: cy };
    else if (head) {
      const short = Math.max(w, h) * 0.015;
      tip =
        shape.y + shape.h <= head.y
          ? { x: clamp(cx, head.x + head.w * 0.2, head.x + head.w * 0.8), y: head.y - short }
          : shape.y >= head.y + head.h
            ? { x: clamp(cx, head.x + head.w * 0.2, head.x + head.w * 0.8), y: head.y + head.h + short }
            : { x: cx < head.x + head.w / 2 ? head.x - short : head.x + head.w + short, y: head.y + head.h * 0.45 };
    } else {
      const side = panel.positions[item.who];
      tip = { x: side ? SIDE[side] * w : cx, y: Math.min(h * 0.55, shape.y + shape.h + h * 0.1) };
    }
    const angle = Math.atan2(tip.y - cy, tip.x - cx);
    // The point on the ellipse facing the tip.
    const rx = shape.w / 2;
    const ry = shape.h / 2;
    const r = (rx * ry) / Math.hypot(ry * Math.cos(angle), rx * Math.sin(angle));
    const base = { x: cx + Math.cos(angle) * r * 0.92, y: cy + Math.sin(angle) * r * 0.92 };
    return { base, tip, half: Math.min(shape.w, shape.h) * 0.14 };
  }

  /** An SVG path for a tail: fill it, and stroke only `tailEdges`, so its base merges into the balloon. */
  function tailPath(t: Tail): string {
    const { base, tip, half } = t;
    const angle = Math.atan2(tip.y - base.y, tip.x - base.x);
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const mx = (base.x + tip.x) / 2;
    const my = (base.y + tip.y) / 2;
    return (
      `M ${f(base.x + nx * half)} ${f(base.y + ny * half)} Q ${f(mx + nx * half * 0.3)} ${f(my + ny * half * 0.3)} ${f(tip.x)} ${f(tip.y)} ` +
      `Q ${f(mx - nx * half * 0.1)} ${f(my - ny * half * 0.1)} ${f(base.x - nx * half)} ${f(base.y - ny * half)} Z`
    );
  }

  /** The two sides of a tail, without its base. */
  function tailEdges(t: Tail): string {
    return tailPath(t).replace(/ Z$/, '');
  }

  /** A spiky outline around a shape, for a `[loud]` balloon. */
  function burstPath(s: Rect, spikes = 18): string {
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const points: string[] = [];
    for (let i = 0; i < spikes * 2; i++) {
      const a = (Math.PI * i) / spikes;
      const k = i % 2 ? 0.86 : 1.1;
      points.push(`${f(cx + Math.cos(a) * (s.w / 2) * k)} ${f(cy + Math.sin(a) * (s.h / 2) * k)}`);
    }
    return `M ${points.join(' L ')} Z`;
  }

  const f = (n: number) => String(Math.round(n * 10) / 10);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
  const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

  function clip(r: Rect, to: Rect): Rect {
    const x = Math.max(r.x, to.x);
    const y = Math.max(r.y, to.y);
    return { x, y, w: Math.min(r.x + r.w, to.x + to.w) - x, h: Math.min(r.y + r.h, to.y + to.h) - y };
  }

  function overlapArea(a: Rect, b: Rect): number {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  }

  function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  return { LETTERING, panelHeads, wrap, letterPanel, tailPath, tailEdges, burstPath, overlapArea };
}

export const { LETTERING, panelHeads, wrap, letterPanel, tailPath, tailEdges, burstPath, overlapArea } = lettering();
