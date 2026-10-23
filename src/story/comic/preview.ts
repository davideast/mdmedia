import type { DrawResult } from './draw.js';
import type { ComicScript } from './types.js';

/** `3.2` → `art/panel-3-2.png` */
export const panelFile = (id: string, mimeType = 'image/png') => `art/panel-${id.replace('.', '-')}.${mimeType.includes('jpeg') ? 'jpg' : 'png'}`;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * A page that lays out the drawn panels on their pages, without lettering, with
 * each panel's check results, so a person can review the art.
 */
export function previewHtml(comic: ComicScript, result: DrawResult): string {
  const byId = new Map(result.panels.map((p) => [p.id, p]));
  const failing = result.panels.filter((p) => !p.ok).length;
  const pages = comic.pages
    .map((page) => {
      const panels = page.panels
        .map((panel) => {
          const r = byId.get(panel.id)!;
          const s = panel.slot;
          const style = `left:${(s.x / comic.page.width) * 100}%;top:${(s.y / comic.page.height) * 100}%;width:${(s.w / comic.page.width) * 100}%;height:${(s.h / comic.page.height) * 100}%`;
          const failed = r.questions.filter((_, i) => !r.answers[i]);
          const badge = r.ok ? `✓${r.attempts > 1 ? ` ${r.attempts} takes` : ''}` : `✗ ${failed.length} of ${r.questions.length}`;
          return (
            `<figure class="panel${r.ok ? '' : ' failing'}" style="${style}">` +
            `<img src="${panelFile(panel.id)}" alt="${escape(panel.shot)}" loading="lazy">` +
            `<figcaption><b>${panel.id}</b> ${badge}${failed.length ? `<span>${failed.map(escape).join('<br>')}</span>` : ''}</figcaption>` +
            `</figure>`
          );
        })
        .join('');
      return `<section class="page" aria-label="Page ${page.index}">${panels}<div class="folio">${page.index}</div></section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(comic.meta.title)}</title>
<style>
:root { --bg: #e4e7ec; --page: #fff; --ink: #111318; --muted: #5c6370; --ok: #2f7d4f; --bad: #b4531a; }
@media (prefers-color-scheme: dark) { :root { --bg: #101318; --page: #1b1f27; --ink: #edf1f8; --muted: #a0a8b6; --ok: #7fcf9e; --bad: #f0a46c; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; padding: 1.5rem 16px 3rem; }
main { max-width: 44rem; margin: 0 auto; display: grid; gap: 2rem; }
h1 { margin: 0; font-size: 1.6rem; } p { margin: 0; color: var(--muted); }
.page { position: relative; width: 100%; aspect-ratio: 2 / 3; background: var(--page); box-shadow: 0 12px 30px rgb(0 0 0 / .18); }
.panel { position: absolute; margin: 0; overflow: hidden; border: 3px solid #111318; background: #f3f4f6; }
.panel img { width: 100%; height: 100%; object-fit: cover; display: block; }
.panel figcaption { position: absolute; left: 4px; bottom: 4px; max-width: calc(100% - 8px); background: rgb(17 19 24 / .78); color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
.panel.failing { border-color: var(--bad); }
.panel figcaption span { display: block; color: #ffd2b0; }
.folio { position: absolute; right: 8px; bottom: 2px; font-size: 11px; color: var(--muted); }
</style></head><body><main>
<header><h1>${escape(comic.meta.title)}</h1>
<p>${result.panels.length} panels, ${failing ? `${failing} still failing a check` : 'all checks passed'}. Art only; lettering comes in the next milestone.</p></header>
${pages}
</main></body></html>
`;
}
