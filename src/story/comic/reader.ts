import { lettering } from './letter.js';
import { readerClient, type ReaderData } from './reader-client.js';

/**
 * Icons from Lucide (ISC), inline so the reader needs nothing but its files.
 * Every top bar action is the same 32px filled circle with a 16px icon, as in
 * mdmedia studio's header.
 */
const ICONS = {
  guided: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  page: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
};

const icon = (id: string, paths: string, hidden = false) =>
  `<svg id="${id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${hidden ? ' hidden' : ''}>${paths}</svg>`;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** JSON that is safe inside a <script>. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');

/** Colors and type from mdmedia studio's globals.css, copied, never imported. */
const CSS = `
:root {
  --surface-page: #ffffff; --surface-inset: #f7f7f7; --ink-primary: #222722; --ink-muted: #707270; --ink-faint: #898a89;
  --border-hairline: #d7d8d7; --foreground: #222722; --background: #ffffff; --mint: #047857;
  --font-display: "Plus Jakarta Sans", "Inter", sans-serif; --font-sans: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
  --comic-ink: #111318; --caption: #fdf3c4; --sfx: #f2b632;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark; --surface-page: #141615; --surface-inset: #191c1a; --ink-primary: #f3f5f3; --ink-muted: #9da19e; --ink-faint: #6f7470;
    --border-hairline: rgba(255, 255, 255, 0.11); --foreground: #f3f5f3; --background: #141615; --mint: #a7f3d0;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark; --surface-page: #141615; --surface-inset: #191c1a; --ink-primary: #f3f5f3; --ink-muted: #9da19e; --ink-faint: #6f7470;
  --border-hairline: rgba(255, 255, 255, 0.11); --foreground: #f3f5f3; --background: #141615; --mint: #a7f3d0;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--surface-page); color: var(--ink-primary); font: 16px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; overflow-x: hidden; }

.bar {
  position: sticky; top: 0; z-index: 10; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem;
  height: 3.5rem; padding-inline: max(1rem, env(safe-area-inset-left)); background: var(--surface-page); border-bottom: 1px solid var(--border-hairline);
}
.bar h1 { margin: 0; font: 600 1.05rem/1.2 var(--font-display); letter-spacing: -0.014em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions { display: flex; gap: 0.5rem; }
.action {
  display: inline-flex; width: 2rem; height: 2rem; flex: none; align-items: center; justify-content: center; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--foreground) 12%, transparent); color: var(--foreground); cursor: pointer; transition: background-color 0.15s;
}
.action:hover { background: color-mix(in srgb, var(--foreground) 20%, transparent); }
.action.primary { background: var(--foreground); color: var(--background); }
.action.primary:hover { opacity: 0.9; }
.action:focus-visible { outline: 1px solid var(--foreground); outline-offset: 2px; }

.view {
  display: grid; grid-template-columns: [full-start] minmax(1rem, 1fr) [content-start] minmax(0, 44rem) [content-end] minmax(1rem, 1fr) [full-end];
  row-gap: 2rem; padding-block: 1.5rem 3rem;
}
.view > * { grid-column: content; }
.page { position: relative; width: 100%; aspect-ratio: 2 / 3; background: #ffffff; border: 1px solid var(--border-hairline); container-type: inline-size; }
.folio { position: absolute; right: 1.6cqw; bottom: 0.3cqw; font: 600 1.3cqw/1 var(--font-sans); color: #898a89; }
.panel { position: absolute; overflow: hidden; border: 0.45cqw solid var(--comic-ink); background: #f3f4f6; }
.panel img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.panel svg.ink { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.outlines * { fill: var(--comic-ink); stroke: var(--comic-ink); stroke-linejoin: round; }
.fills * { fill: #ffffff; stroke: none; }
.lettering { position: absolute; inset: 0; }
.item {
  position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; white-space: nowrap;
  color: var(--comic-ink); font-family: "Comic Neue", "Comic Sans MS", sans-serif; font-weight: 700; line-height: 1.18; letter-spacing: 0.02em;
}
.item[data-audio] { cursor: pointer; }
.caption { justify-content: flex-start; text-align: left; padding-inline: 0.55em; background: var(--caption); box-shadow: 0 0 0 0.12em var(--comic-ink); }
.sfx {
  font-family: Bangers, Impact, sans-serif; font-weight: 400; line-height: 1; letter-spacing: 0.04em; color: var(--sfx);
  -webkit-text-stroke: 0.06em var(--comic-ink); paint-order: stroke fill; text-shadow: 0.06em 0.06em 0 var(--comic-ink); transform: rotate(-8deg);
}
.item.speaking { outline: 0.2em solid var(--mint); outline-offset: 0.15em; border-radius: 999px; }
.caption.speaking { border-radius: 2px; }

#guided { display: none; }
body.guided #pages { display: none; }
body.guided #guided { display: grid; grid-template-rows: minmax(0, 1fr) auto; height: calc(100dvh - 3.5rem); background: var(--surface-inset); }
#stage { display: grid; place-items: center; min-height: 0; padding: 1rem; overflow: hidden; touch-action: pan-y; cursor: pointer; }
#stage .panel { position: relative; border-width: 3px; }
#where { margin: 0; padding: 0.5rem 1rem calc(0.75rem + env(safe-area-inset-bottom)); text-align: center; font-size: 0.75rem; color: var(--ink-muted); }
`;

/** The reader's single page: styles, the comic's data, the lettering and the reader script, all inline. */
export function readerHtml(data: ReaderData): string {
  const hasAudio = data.pages.some((p) => p.panels.some((panel) => panel.items.some((i) => i.audio)));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(data.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@700&family=Inter:wght@400;600&family=Plus+Jakarta+Sans:wght@600&display=swap">
<style>${CSS}</style>
</head>
<body>
<header class="bar">
  <h1>${escape(data.title)}</h1>
  <div class="actions">
    <button id="view" class="action" type="button" aria-label="Guided view" aria-pressed="false">${icon('view-guided', ICONS.guided)}${icon('view-page', ICONS.page, true)}</button>
    ${hasAudio ? `<button id="read" class="action primary" type="button" aria-label="Read aloud">${icon('read-play', ICONS.play)}${icon('read-pause', ICONS.pause, true)}</button>` : '<span id="read" hidden></span>'}
  </div>
</header>
<main id="pages" class="view"></main>
<section id="guided" aria-label="Guided view">
  <div id="stage"></div>
  <p id="where"></p>
</section>
<script>
const COMIC = ${scriptJson(data)};
(${readerClient.toString()})(COMIC, (${lettering.toString()})());
</script>
</body>
</html>
`;
}
