import type { Line } from '../types.js';

/** One scene as the adapter returns it. */
export interface SceneAdaptation {
  setting: string;
  staging?: string;
  rules?: string;
  pages: AdaptedPage[];
}

export interface AdaptedPage {
  /** Panels per row, top to bottom. */
  rows: number[];
  panels: AdaptedPanel[];
}

export interface AdaptedPanel {
  shot: string;
  left?: string[];
  center?: string[];
  right?: string[];
  zone: 'top' | 'bottom';
  acting: string;
  setting?: string;
  continues?: boolean;
  items: AdaptedItem[];
}

export type AdaptedItem = { line: string; text?: string; mark?: 'small' | 'loud' | 'off' } | { sfx: string };

/** A scene's lines by the ids the adapter sees: L1, L2, … */
export type SceneLines = Map<string, Line>;

export const sceneLineIds = (lines: Line[]): SceneLines => new Map(lines.map((line, i) => [`L${i + 1}`, line]));

/** Where each scene's pages start in the assembled file, for sorting problems back to scenes. */
export interface Assembled {
  markdown: string;
  /** For each scene, its first page number (pages are numbered across the comic). */
  firstPage: number[];
}

/**
 * The comic script: front matter, then every scene's pages, numbered across
 * the comic. A page that starts a scene sets its setting, staging and rules
 * (clearing the last scene's); a panel that cuts elsewhere gets its own
 * setting. Cues come from the story's lines; a speaker who isn't drawn in the
 * panel is marked [off].
 */
export function assembleComic(meta: { title: string; story: string; style: string }, scenes: Array<{ adaptation: SceneAdaptation; lines: SceneLines }>): Assembled {
  const out = ['---', `title: ${yamlLine(meta.title)}`, `story: ${yamlLine(meta.story)}`, `style: ${yamlLine(meta.style)}`, '---', ''];
  const firstPage: number[] = [];
  let page = 0;
  let staged = false;
  let ruled = false;

  scenes.forEach(({ adaptation, lines }) => {
    firstPage.push(page + 1);
    adaptation.pages.forEach((p, pageIndex) => {
      page++;
      out.push(`## Page ${page}`, '');
      out.push(`layout: ${p.rows.map((n) => Array.from({ length: n }, () => '1').join(' ')).join(' | ')}`);
      if (pageIndex === 0) {
        out.push(block('setting', adaptation.setting));
        if (adaptation.staging) out.push(block('staging', adaptation.staging));
        else if (staged) out.push('staging: ""');
        if (adaptation.rules) out.push(block('rules', adaptation.rules));
        else if (ruled) out.push('rules: ""');
        staged = Boolean(adaptation.staging);
        ruled = Boolean(adaptation.rules);
      }
      out.push('');
      p.panels.forEach((panel, i) => {
        out.push(`### Panel ${i + 1}`, '');
        if (panel.setting) out.push(`setting: ${oneLine(panel.setting)}`, '');
        if (panel.continues && i > 0) out.push(`continue: ${page}.${i}`, '');
        out.push(...artNote(panel), '');
        for (const item of panel.items) {
          const text = itemText(item, lines);
          if (text) out.push(text, '');
        }
      });
    });
  });
  return { markdown: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', firstPage };
}

/** Everyone placed in a panel. */
export function placed(panel: AdaptedPanel): string[] {
  return [...(panel.left ?? []), ...(panel.center ?? []), ...(panel.right ?? [])];
}

function artNote(panel: AdaptedPanel): string[] {
  const sides = (['left', 'center', 'right'] as const)
    .filter((side) => panel[side]?.length)
    .map((side) => `${side[0]!.toUpperCase()}${side.slice(1)}: ${panel[side]!.join(' and ')}.`);
  const note = [oneLine(panel.shot).replace(/([^.!?])$/, '$1.'), ...sides, `Balloons: ${panel.zone === 'bottom' ? 'bottom' : 'top'}.`].join(' ');
  return [...wrap(note, 78).map((l) => `> ${l}`), '>', ...wrap(`acting: ${oneLine(panel.acting)}`, 78).map((l) => `> ${l}`)];
}

function itemText(item: AdaptedItem, lines: SceneLines): string | undefined {
  if ('sfx' in item) return '```sfx\n' + oneLine(item.sfx) + '\n```';
  const line = lines.get(item.line);
  if (!line) return undefined;
  const text = oneLine(item.text ?? line.display);
  const cue = line.cue ? ` *(${line.cue})*` : '';
  if (line.narration) return `${cue.trim()} ${text}`.trim();
  const mark = item.mark ? ` [${item.mark}]` : '';
  return `**${line.speaker}**${cue}${mark}: ${text}`;
}

/** Marks a balloon [off] when its speaker isn't drawn in the panel. */
export function markOffPanel(panel: AdaptedPanel, lines: SceneLines): AdaptedPanel {
  const here = new Set(placed(panel));
  return {
    ...panel,
    items: panel.items.map((item) => {
      if ('sfx' in item || item.mark) return item;
      const line = lines.get(item.line);
      return line && !line.narration && !here.has(line.speaker) ? { ...item, mark: 'off' } : item;
    }),
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const yamlLine = (text: string) => (/[:#'"\[\]{}]|^\s|\s$/.test(text) ? JSON.stringify(text) : text);

function block(key: string, text: string): string {
  return `${key}: >-\n${wrap(oneLine(text), 76).map((l) => `  ${l}`).join('\n')}`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
