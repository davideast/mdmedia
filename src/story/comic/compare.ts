import type { ReaderData } from './reader-client.js';

/** One reader build, as the comparison sees it: its data and which files changed. */
export interface CompareSide {
  label: string;
  data: ReaderData;
  /** Folder name the page links its files from: `before/` or `after/`. */
  root: string;
}

export interface CompareInput {
  title: string;
  before: CompareSide;
  after: CompareSide;
  /** Panel ids whose art differs, and item ids whose audio differs. */
  changedArt: Set<string>;
  changedAudio: Set<string>;
  /** Show every panel, or only the ones that changed. */
  onlyChanged?: boolean;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * A before/after review page for two builds of a comic: each panel's art side
 * by side, and each caption or balloon's two takes. Nothing replaces a
 * published reader until this page has been reviewed (plan 009).
 */
export function compareHtml(input: CompareInput): string {
  const { before, after } = input;
  const beforePanels = new Map(before.data.pages.flatMap((p) => p.panels).map((p) => [p.id, p]));
  const rows = after.data.pages.flatMap((page) =>
    page.panels.flatMap((panel) => {
      const old = beforePanels.get(panel.id);
      const artChanged = input.changedArt.has(panel.id);
      const lines = panel.items
        .map((item, i) => ({ item, i, oldItem: old?.items[i] }))
        .filter(({ item }) => item.kind !== 'sfx');
      const audioChanged = lines.some(({ i }) => input.changedAudio.has(`${panel.id}-${i}`));
      if (input.onlyChanged && !artChanged && !audioChanged) return [];
      const items = lines
        .map(({ item, i, oldItem }) => {
          const id = `${panel.id}-${i}`;
          const changed = input.changedAudio.has(id);
          const who = item.kind === 'balloon' ? item.who : 'caption';
          const play = (side: CompareSide, it: typeof item | undefined, label: string) =>
            it && 'audio' in it && it.audio ? `<button class="play" type="button" data-src="${side.root}${it.audio}">${label}</button>` : '';
          return `<li class="${changed ? 'changed' : ''}"><span class="who">${escape(who)}</span><span class="text">${escape(item.text)}</span><span class="pair">${play(before, oldItem, before.label)}${play(after, item, after.label)}</span></li>`;
        })
        .join('');
      return [
        `<section class="panel-row${artChanged ? ' changed' : ''}" id="p${panel.id}">
<h2>Panel ${panel.id}${artChanged ? ' <span class="tag">art changed</span>' : ''}${audioChanged ? ' <span class="tag">voices changed</span>' : ''}</h2>
<div class="art"><figure><img src="${before.root}${old?.image ?? panel.image}" alt="" loading="lazy"><figcaption>${escape(before.label)}</figcaption></figure>
<figure><img src="${after.root}${panel.image}" alt="" loading="lazy"><figcaption>${escape(after.label)}</figcaption></figure></div>
${items ? `<ul class="lines">${items}</ul>` : ''}
</section>`,
      ];
    })
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Plus+Jakarta+Sans:wght@600&display=swap">
<style>
:root { --page:#fff; --card:#fff; --inset:#f7f7f7; --ink:#222722; --muted:#707270; --faint:#898a89; --line:#d7d8d7; --fg:#222722; --bg:#fff; --mint:#047857; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme:dark; --page:#141615; --card:#1a1d1b; --inset:#191c1a; --ink:#f3f5f3; --muted:#9da19e; --faint:#6f7470; --line:rgba(255,255,255,.11); --fg:#f3f5f3; --bg:#141615; --mint:#a7f3d0; } }
:root[data-theme="dark"] { color-scheme:dark; --page:#141615; --card:#1a1d1b; --inset:#191c1a; --ink:#f3f5f3; --muted:#9da19e; --faint:#6f7470; --line:rgba(255,255,255,.11); --fg:#f3f5f3; --bg:#141615; --mint:#a7f3d0; }
* { box-sizing:border-box; } body { margin:0; background:var(--page); color:var(--ink); font:15px/1.5 Inter, system-ui, sans-serif; }
main { display:grid; grid-template-columns:minmax(1rem,1fr) minmax(0,64rem) minmax(1rem,1fr); row-gap:2rem; padding-block:1.5rem 4rem; }
main > * { grid-column:2; }
h1 { margin:0; font:600 1.5rem/1.2 "Plus Jakarta Sans", Inter, sans-serif; letter-spacing:-.02em; }
.lead { margin:.4rem 0 0; color:var(--muted); }
.panel-row { display:grid; gap:.75rem; border-top:1px solid var(--line); padding-top:1rem; }
.panel-row h2 { margin:0; font:600 1rem/1.3 Inter, sans-serif; display:flex; gap:.5rem; align-items:center; }
.tag { font-size:.72rem; font-weight:600; color:var(--mint); }
.art { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; }
@media (max-width: 640px) { .art { grid-template-columns:1fr; } }
.art figure { margin:0; } .art img { width:100%; display:block; border-radius:6px; border:1px solid var(--line); }
.art figcaption { font-size:.75rem; color:var(--muted); margin-top:.25rem; }
.lines { list-style:none; margin:0; padding:0; display:grid; gap:.4rem; }
.lines li { display:grid; grid-template-columns:7rem 1fr auto; gap:.6rem; align-items:center; font-size:.88rem; }
.lines li.changed .text { font-weight:600; }
.who { color:var(--faint); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
.pair { display:flex; gap:.35rem; }
@media (max-width: 640px) { .lines li { grid-template-columns:1fr; } }
.play { height:1.9rem; padding:0 .7rem; border:0; border-radius:999px; font:600 .75rem/1 Inter, sans-serif; cursor:pointer; background:color-mix(in srgb, var(--fg) 12%, transparent); color:var(--fg); }
.play.playing { background:var(--fg); color:var(--bg); }
</style></head><body><main>
<header><h1>${escape(input.title)}</h1><p class="lead">${escape(before.label)} against ${escape(after.label)}. ${input.changedArt.size} panels with changed art, ${input.changedAudio.size} lines with new takes.</p></header>
${rows.join('\n')}
</main>
<script>
let current;
document.addEventListener('click', (e) => {
  const b = e.target.closest('.play'); if (!b) return;
  if (current) { current.a.pause(); current.b.classList.remove('playing'); if (current.b === b) { current = undefined; return; } }
  const a = new Audio(b.dataset.src); current = { a, b }; b.classList.add('playing');
  a.addEventListener('ended', () => b.classList.remove('playing')); a.play().catch(() => b.classList.remove('playing'));
});
</script></body></html>
`;
}
