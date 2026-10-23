import { isMap, isScalar, parse as parseYaml, parseDocument, type Node } from 'yaml';
import { sha256 } from '../parse.js';
import { SourceMap } from '../source.js';
import type { CastMember, Diagnostic } from '../types.js';
import { layoutSlots, nearestAspect, PAGE, parseLayout } from './geometry.js';
import type { ComicItem, ComicPage, ComicPanel, ComicScript } from './types.js';

const FRONT_KEYS = new Set(['title', 'story', 'style', 'setting', 'staging', 'rules']);
const PAGE_KEYS = new Set(['layout', 'setting', 'staging', 'rules']);
const BALLOON = /^\*\*([^*\n]+)\*\*[ \t]*(?:\*\(([^)\n]*)\)\*)?[ \t]*(?:\[(small|off|loud)\])?[ \t]*:[ \t]*([\s\S]*)$/;
const CUED = /^\*\(([^)\n]*)\)\*[ \t]+([\s\S]*)$/;
const POSITIONS = /\b(Left|Right|Center):\s*([A-Z][A-Z0-9_]*(?:\s+and\s+[A-Z][A-Z0-9_]*)*)\./g;

export interface ComicParseResult {
  comic?: ComicScript;
  diagnostics: Diagnostic[];
}

/**
 * Parses a comic script (design 4.2). `cast` is the story's cast, named by the
 * script's `story:`; without it, speakers are not checked. Pure.
 */
export async function parseComic(markdown: string, options: { path: string; cast?: Record<string, CastMember> }): Promise<ComicParseResult> {
  const map = new SourceMap(markdown);
  const diagnostics: Diagnostic[] = [];
  const error = (code: Diagnostic['code'], message: string, start: number, end: number) =>
    diagnostics.push({ code, severity: 'error', message, source: map.range(start, end) });

  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!fm) {
    error('missing-front-matter', 'A comic script starts with front matter: title, story and style.', 0, Math.max(0, markdown.indexOf('\n')));
    return { diagnostics };
  }
  const yamlStart = fm[0].indexOf(fm[1]!);
  const doc = parseDocument(fm[1]!, { prettyErrors: false });
  for (const e of doc.errors) error('bad-yaml', e.message.split('\n')[0]!, yamlStart + e.pos[0], yamlStart + e.pos[1]);
  if (diagnostics.length) return { diagnostics };
  const front: Record<string, string> = {};
  if (!isMap(doc.contents)) {
    error('bad-yaml', 'Front matter must be a set of keys.', 0, 3);
    return { diagnostics };
  }
  for (const pair of doc.contents.items) {
    const key = String(isScalar(pair.key) ? pair.key.value : '');
    const range = (pair.key as Node).range ?? [0, 0, 0];
    if (!FRONT_KEYS.has(key)) error('unknown-key', `Unknown comic key "${key}". Allowed: ${[...FRONT_KEYS].join(', ')}.`, yamlStart + range[0], yamlStart + range[1]);
    else front[key] = String(isScalar(pair.value) ? pair.value.value ?? '' : '').trim();
  }
  for (const key of ['title', 'story', 'style']) {
    if (!front[key]) error('missing-field', `A comic script needs ${key}.`, 0, 3);
  }

  // Pages: `## Page N`, then page keys, then `### Panel N` blocks.
  const pages: ComicPage[] = [];
  const pageHeads = [...markdown.matchAll(/^## Page (\d+)[ \t]*$/gm)];
  let setting = front.setting || undefined;
  let staging = front.staging || undefined;
  let rules = front.rules || undefined;
  const allPanelIds = new Set<string>();
  const pending: Array<{ panel: ComicPanel; target: string; start: number; end: number }> = [];

  pageHeads.forEach((head, p) => {
    const pageNumber = Number(head[1]);
    const start = head.index! + head[0].length;
    const end = p + 1 < pageHeads.length ? pageHeads[p + 1]!.index! : markdown.length;
    const block = markdown.slice(start, end);
    const panelHeads = [...block.matchAll(/^### Panel (\d+)[ \t]*$/gm)];
    const headerText = block.slice(0, panelHeads[0]?.index ?? block.length);

    let header: Record<string, unknown> = {};
    try {
      header = (parseYaml(headerText) as Record<string, unknown> | null) ?? {};
    } catch (e) {
      error('bad-yaml', `Page ${pageNumber}: ${(e as Error).message.split('\n')[0]}`, head.index!, start);
    }
    for (const key of Object.keys(header)) {
      if (!PAGE_KEYS.has(key)) error('unknown-key', `Unknown page key "${key}". Allowed: ${[...PAGE_KEYS].join(', ')}.`, head.index!, start);
    }
    // A page key replaces what came before; an empty value clears it.
    if (typeof header.setting === 'string') setting = header.setting.trim() || undefined;
    if (typeof header.staging === 'string') staging = header.staging.trim() || undefined;
    if (typeof header.rules === 'string') rules = header.rules.trim() || undefined;
    const layout = parseLayout(String(header.layout ?? '1'));
    if (!layout) {
      error('missing-field', `Page ${pageNumber} needs a layout such as "1 | 1 1".`, head.index!, start);
      return;
    }
    const slots = layoutSlots(layout);
    if (slots.length !== panelHeads.length) {
      error('layout-mismatch', `Page ${pageNumber}'s layout has ${slots.length} panels but the page has ${panelHeads.length}.`, head.index!, start);
      return;
    }

    const panels: ComicPanel[] = panelHeads.map((ph, i) => {
      const panelStart = start + ph.index!;
      const bodyStart = panelStart + ph[0].length;
      const bodyEnd = i + 1 < panelHeads.length ? start + panelHeads[i + 1]!.index! : end;
      const index = Number(ph[1]);
      const id = `${pageNumber}.${index}`;
      allPanelIds.add(id);
      const parsed = parsePanelBody(markdown, bodyStart, bodyEnd, map, options.cast, diagnostics);
      const slot = slots[i]!;
      const panel: ComicPanel = {
        id,
        page: pageNumber,
        index,
        slot,
        aspect: nearestAspect(slot.w / slot.h),
        shot: parsed.shot,
        acting: parsed.acting,
        positions: parsed.positions,
        zone: parsed.zone,
        ...(setting ? { setting } : {}),
        ...(staging ? { staging } : {}),
        ...(rules ? { rules } : {}),
        items: parsed.items,
        source: map.range(panelStart, panelStart + ph[0].length),
      };
      if (!parsed.shot) error('missing-field', `Panel ${id} needs an art note: a paragraph starting with ">".`, panelStart, panelStart + ph[0].length);
      if (parsed.continues) pending.push({ panel, target: parsed.continues.target, start: parsed.continues.start, end: parsed.continues.end });
      return panel;
    });
    pages.push({ index: pageNumber, layout, panels });
  });

  // A panel can only continue one that comes before it.
  const order = pages.flatMap((p) => p.panels.map((x) => x.id));
  for (const { panel, target, start, end } of pending) {
    if (!allPanelIds.has(target) || order.indexOf(target) >= order.indexOf(panel.id)) {
      error('bad-continue', `Panel ${panel.id} continues ${target}, which must be an earlier panel.`, start, end);
    } else panel.continues = target;
  }

  if (!pages.length && !diagnostics.some((d) => d.severity === 'error')) error('missing-field', 'A comic script needs at least one "## Page" with panels.', 0, 3);
  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };
  return {
    comic: {
      schema: 'mdmedia.story.comic/1',
      source: { path: options.path, sha256: await sha256(markdown) },
      meta: {
        title: front.title!,
        story: front.story!,
        style: front.style!,
        ...(front.setting ? { setting: front.setting } : {}),
        ...(front.staging ? { staging: front.staging } : {}),
        ...(front.rules ? { rules: front.rules } : {}),
      },
      page: { width: PAGE.width, height: PAGE.height, gutter: PAGE.gutter },
      pages,
    },
    diagnostics,
  };
}

function parsePanelBody(markdown: string, start: number, end: number, map: SourceMap, cast: Record<string, CastMember> | undefined, diagnostics: Diagnostic[]) {
  const text = markdown.slice(start, end);
  const result = {
    shot: '',
    acting: '',
    positions: {} as ComicPanel['positions'],
    zone: 'top' as 'top' | 'bottom',
    continues: undefined as { target: string; start: number; end: number } | undefined,
    items: [] as ComicItem[],
  };
  const range = (s: number, e: number) => map.range(start + s, start + e);
  const unknown = (name: string, s: number, e: number) =>
    diagnostics.push({ code: 'unknown-speaker', severity: 'error', message: `${name} is not in the story's cast.`, source: range(s, e) });

  // Paragraphs with their offsets; fenced blocks stay whole.
  const paragraphs: Array<{ text: string; start: number; end: number }> = [];
  const re = /```[\s\S]*?```|(?:[^\n]+\n?)+/g;
  for (const m of text.matchAll(re)) {
    const body = m[0].replace(/\n+$/, '');
    if (body.trim()) paragraphs.push({ text: body, start: m.index!, end: m.index! + body.length });
  }

  for (const p of paragraphs) {
    const continueMatch = /^continue:\s*(\S+)\s*$/.exec(p.text);
    if (continueMatch) { result.continues = { target: continueMatch[1]!, start: start + p.start, end: start + p.end }; continue; }
    if (p.text.startsWith('>')) {
      const quoted = p.text.split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
      const [note, ...actingParts] = quoted.split(/\n\s*\n?\s*acting:\s*/);
      if (actingParts.length) result.acting = actingParts.join(' ').replace(/\s+/g, ' ').trim();
      const noteText = (note ?? '').replace(/\s+/g, ' ').trim();
      for (const m of noteText.matchAll(POSITIONS)) {
        for (const name of m[2]!.split(/\s+and\s+/)) {
          if (cast && !cast[name]) unknown(name, p.start, p.end);
          result.positions[name] = m[1]!.toLowerCase() as 'left' | 'center' | 'right';
        }
      }
      if (/Balloons:\s*bottom/i.test(noteText)) result.zone = 'bottom';
      result.shot = noteText.replace(POSITIONS, '').replace(/\s*Balloons:\s*(top|bottom)\./i, '').replace(/\s+/g, ' ').trim();
      continue;
    }
    const sfx = /^```sfx\n([\s\S]*?)\n```$/.exec(p.text);
    if (sfx) { result.items.push({ kind: 'sfx', text: sfx[1]!.trim(), source: range(p.start, p.end) }); continue; }
    if (p.text.startsWith('```')) continue;
    const flat = p.text.trim();
    const balloon = BALLOON.exec(flat);
    if (balloon) {
      const who = balloon[1]!.trim().toUpperCase();
      if (cast && !cast[who]) {
        const at = p.text.indexOf(balloon[1]!);
        unknown(balloon[1]!.trim(), p.start + at, p.start + at + balloon[1]!.length);
        continue;
      }
      const words = balloon[4]!.replace(/\s+/g, ' ').trim();
      const item: ComicItem = { kind: 'balloon', who, cue: (balloon[2] ?? '').trim(), text: spoken(words), display: words, source: range(p.start, p.end) };
      if (balloon[3]) item.mark = balloon[3] as 'small' | 'off' | 'loud';
      result.items.push(item);
      if (!item.cue) diagnostics.push({ code: 'missing-cue', severity: 'warning', message: `${who}'s balloon has no cue for its voice.`, source: item.source });
      continue;
    }
    const cued = CUED.exec(flat);
    const words = (cued ? cued[2]! : flat).replace(/\s+/g, ' ').trim();
    const caption: ComicItem = { kind: 'caption', cue: (cued?.[1] ?? '').trim(), text: spoken(words), display: words, source: range(p.start, p.end) };
    result.items.push(caption);
    if (!caption.cue) diagnostics.push({ code: 'missing-cue', severity: 'warning', message: 'This caption has no cue for its voice.', source: caption.source });
  }
  return result;
}

function spoken(markdown: string): string {
  return markdown.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(.+?)\1/g, '$2').replace(/`([^`]*)`/g, '$1').trim();
}
