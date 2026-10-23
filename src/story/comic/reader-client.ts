import type { lettering as Lettering, LetterItem, Placed } from './letter.js';

/** What the reader page is given: the comic's pages, art, head boxes and audio. */
export interface ReaderData {
  title: string;
  page: { width: number; height: number; gutter: number };
  pages: Array<{
    index: number;
    panels: Array<{
      id: string;
      slot: { x: number; y: number; w: number; h: number };
      aspect: string;
      positions: Record<string, 'left' | 'center' | 'right'>;
      zone: 'top' | 'bottom';
      image: string;
      heads: Array<{ id: string; box: [number, number, number, number] }>;
      items: Array<LetterItem & { audio?: string }>;
    }>;
  }>;
}

/**
 * The reader, run in the browser. Its source is inlined into the page, so it
 * uses nothing from outside this function: the comic and the lettering come in
 * as arguments.
 *
 * - Page view: whole pages, lettered at 2% of the page width.
 * - Guided view: one panel at a time, re-lettered at a readable minimum; tap
 *   the right or left of the panel, or use the arrow keys, to move.
 * - Tap a caption or balloon to hear it; Read aloud plays the current panel in
 *   order, then turns to the next.
 * - The view and position stay in the URL hash.
 */
export function readerClient(comic: ReaderData, L: ReturnType<typeof Lettering>): void {
  const MIN_GUIDED_PX = 15;
  const GAP_MS = 400;
  const SVG = 'http://www.w3.org/2000/svg';
  const panels = comic.pages.flatMap((p) => p.panels);
  const hasAudio = panels.some((p) => p.items.some((i) => i.audio));
  const $ = (id: string) => document.getElementById(id)!;

  // Text measurement for the layout, matching the CSS: bold Comic Neue with
  // 0.02em letter spacing, and Bangers for sound effects.
  const ctx = document.createElement('canvas').getContext('2d')!;
  const measure = (text: string, px: number, face: 'letter' | 'display') => {
    ctx.font = face === 'display' ? `400 ${px}px Bangers, Impact, sans-serif` : `700 ${px}px "Comic Neue", "Comic Sans MS", sans-serif`;
    return ctx.measureText(text).width + text.length * px * (face === 'display' ? 0.04 : 0.02);
  };

  // ---- Building panels ----

  function panelEl(panel: ReaderData['pages'][number]['panels'][number]): HTMLElement {
    const el = document.createElement('div');
    el.className = 'panel';
    el.dataset.id = panel.id;
    const img = document.createElement('img');
    img.src = panel.image;
    img.alt = '';
    img.decoding = 'async';
    el.append(img);
    const svg = document.createElementNS(SVG, 'svg');
    svg.classList.add('ink');
    el.append(svg);
    const lettering = document.createElement('div');
    lettering.className = 'lettering';
    el.append(lettering);
    return el;
  }

  /** Letters a panel element at its current size. */
  function letter(el: HTMLElement, fontPx: number, minFontPx?: number) {
    const panel = panels.find((p) => p.id === el.dataset.id)!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const result = L.letterPanel(panel, panel.heads, w, h, measure, { fontPx, ...(minFontPx ? { minFontPx } : {}) });
    const svg = el.querySelector('svg')!;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.replaceChildren();
    const layer = el.querySelector('.lettering')!;
    layer.replaceChildren();
    const stroke = Math.max(1.2, result.fontPx * 0.12);
    const outlines = document.createElementNS(SVG, 'g');
    const fills = document.createElementNS(SVG, 'g');
    outlines.setAttribute('class', 'outlines');
    fills.setAttribute('class', 'fills');
    outlines.style.strokeWidth = String(stroke * 2);
    svg.append(outlines, fills);
    for (const placed of result.placed) drawPlaced(panel, placed, layer, outlines, fills);
  }

  function shapeSvg(name: string, attrs: Record<string, string | number>) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  function drawPlaced(panel: ReaderData['pages'][number]['panels'][number], placed: Placed, layer: Element, outlines: Element, fills: Element) {
    if (placed.kind === 'balloon') {
      // Outlines first, fills on top: joined ovals and the tail read as one shape.
      for (const s of placed.shapes) {
        const shape =
          placed.mark === 'loud'
            ? () => shapeSvg('path', { d: L.burstPath(s) })
            : () => shapeSvg('ellipse', { cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: s.w / 2, ry: s.h / 2 });
        outlines.append(shape());
        fills.append(shape());
      }
      if (placed.tail) {
        outlines.append(shapeSvg('path', { d: L.tailPath(placed.tail) }));
        fills.append(shapeSvg('path', { d: L.tailPath(placed.tail) }));
      }
    }
    placed.shapes.forEach((s, k) => {
      const index = placed.items[k] ?? placed.items[0]!;
      const item = panel.items[index]!;
      const div = document.createElement('div');
      div.className = `item ${placed.kind}${placed.mark ? ` ${placed.mark}` : ''}`;
      div.style.left = `${s.x}px`;
      div.style.top = `${s.y}px`;
      div.style.width = `${s.w}px`;
      div.style.height = `${s.h}px`;
      div.style.fontSize = `${placed.fontPx}px`;
      for (const [i, line] of s.lines.entries()) {
        if (i) div.append(document.createElement('br'));
        div.append(line);
      }
      if (item.audio) {
        div.dataset.audio = item.audio;
        div.setAttribute('role', 'button');
        div.tabIndex = 0;
        div.addEventListener('click', (e) => {
          e.stopPropagation();
          stopReading();
          play(div);
        });
      }
      layer.append(div);
    });
  }

  // ---- Page view ----

  const pagesEl = $('pages');
  for (const page of comic.pages) {
    const pageEl = document.createElement('section');
    pageEl.className = 'page';
    pageEl.setAttribute('aria-label', `Page ${page.index}`);
    for (const panel of page.panels) {
      const el = panelEl(panel);
      const { x, y, w, h } = panel.slot;
      el.style.left = `${(x / comic.page.width) * 100}%`;
      el.style.top = `${(y / comic.page.height) * 100}%`;
      el.style.width = `${(w / comic.page.width) * 100}%`;
      el.style.height = `${(h / comic.page.height) * 100}%`;
      pageEl.append(el);
    }
    const folio = document.createElement('span');
    folio.className = 'folio';
    folio.textContent = String(page.index);
    pageEl.append(folio);
    pagesEl.append(pageEl);
  }
  const letterPages = () => {
    for (const pageEl of pagesEl.querySelectorAll<HTMLElement>('.page')) {
      const fontPx = pageEl.clientWidth * 0.02;
      for (const el of pageEl.querySelectorAll<HTMLElement>('.panel')) letter(el, fontPx);
    }
  };

  // ---- Guided view ----

  const stage = $('stage');
  let current = 0;
  let guided = false;

  function showGuided() {
    const panel = panels[current]!;
    const el = panelEl(panel);
    stage.replaceChildren(el);
    // Fit the panel's shape into the stage.
    const box = stage.getBoundingClientRect();
    const scale = Math.min(box.width / panel.slot.w, box.height / panel.slot.h);
    el.style.width = `${panel.slot.w * scale}px`;
    el.style.height = `${panel.slot.h * scale}px`;
    const pageFont = (panel.slot.w * scale * comic.page.width * 0.02) / panel.slot.w;
    letter(el, Math.max(pageFont, MIN_GUIDED_PX), MIN_GUIDED_PX);
    $('where').textContent = `Page ${panel.id.split('.')[0]}, panel ${panel.id.split('.')[1]} of ${panels.filter((p) => p.id.split('.')[0] === panel.id.split('.')[0]).length}`;
  }

  function setView(next: boolean) {
    guided = next;
    document.body.classList.toggle('guided', guided);
    $('view').setAttribute('aria-label', guided ? 'Page view' : 'Guided view');
    $('view').setAttribute('aria-pressed', String(guided));
    $('view-page').toggleAttribute('hidden', !guided);
    $('view-guided').toggleAttribute('hidden', guided);
    if (guided) showGuided();
    else {
      letterPages();
      pagesEl.querySelector(`.panel[data-id="${panels[current]!.id}"]`)?.scrollIntoView({ block: 'center' });
    }
    saveHash();
  }

  function go(delta: number) {
    const next = Math.max(0, Math.min(panels.length - 1, current + delta));
    if (next === current) return false;
    current = next;
    if (guided) showGuided();
    saveHash();
    return true;
  }

  stage.addEventListener('click', (e) => {
    const box = stage.getBoundingClientRect();
    stopReading();
    go(e.clientX - box.left > box.width / 2 ? 1 : -1);
  });
  document.addEventListener('keydown', (e) => {
    if (!guided) return;
    if (e.key === 'ArrowRight') { stopReading(); go(1); }
    if (e.key === 'ArrowLeft') { stopReading(); go(-1); }
    if (e.key === 'Escape') setView(false);
  });
  $('view').addEventListener('click', () => setView(!guided));

  // ---- Audio ----

  let audio: HTMLAudioElement | undefined;
  let reading = false;
  let speaking: HTMLElement | undefined;

  function play(div: HTMLElement): Promise<void> {
    audio?.pause();
    speaking?.classList.remove('speaking');
    speaking = div;
    div.classList.add('speaking');
    audio = new Audio(div.dataset.audio);
    const a = audio;
    return new Promise((resolve) => {
      const done = () => {
        div.classList.remove('speaking');
        resolve();
      };
      a.addEventListener('ended', done, { once: true });
      a.addEventListener('pause', done, { once: true });
      a.addEventListener('error', done, { once: true });
      a.play().catch(done);
    });
  }

  function stopReading() {
    reading = false;
    audio?.pause();
    syncRead();
  }

  async function readAloud() {
    reading = true;
    syncRead();
    while (reading) {
      const root = guided ? stage : pagesEl.querySelector<HTMLElement>(`.panel[data-id="${panels[current]!.id}"]`)!;
      if (!guided) root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      for (const div of root.querySelectorAll<HTMLElement>('.item[data-audio]')) {
        if (!reading) return;
        await play(div);
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
      if (!reading || !go(1)) break;
    }
    reading = false;
    syncRead();
  }

  function syncRead() {
    const button = $('read');
    button.setAttribute('aria-label', reading ? 'Pause' : 'Read aloud');
    $('read-play').toggleAttribute('hidden', reading);
    $('read-pause').toggleAttribute('hidden', !reading);
  }

  if (hasAudio) $('read').addEventListener('click', () => (reading ? stopReading() : readAloud()));
  else $('read').remove();

  // In the page view, tapping a panel makes it the current one.
  pagesEl.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('.panel');
    if (el) current = panels.findIndex((p) => p.id === el.dataset.id);
  });

  // ---- Position in the URL ----

  function saveHash() {
    history.replaceState(null, '', `#${guided ? 'guided' : 'page'}=${panels[current]!.id}`);
  }
  const saved = /^#(page|guided)=(\d+\.\d+)$/.exec(location.hash);
  if (saved) current = Math.max(0, panels.findIndex((p) => p.id === saved[2]));

  // Letter once the fonts and images are ready, and again whenever the size changes.
  Promise.all([document.fonts.load('700 16px "Comic Neue"'), document.fonts.load('16px Bangers')])
    .catch(() => undefined)
    .then(() => {
      setView(saved?.[1] === 'guided');
      let frame = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => (guided ? showGuided() : letterPages()));
      }).observe(document.body);
    });
}
