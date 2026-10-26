import type { CastMember } from '../types.js';
import { placed, type SceneAdaptation, type SceneLines } from './assemble.js';
import { MAX_CAPTION_WORDS, MAX_ITEMS_PER_PANEL, PANELS_PER_PAGE, PANELS_PER_ROW } from './prompts.js';

/** Quotes and spaces as a comparison sees them. */
export const norm = (text: string) => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const words = (text: string) => norm(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Sentences, ending at . ! ? (with any closing quote). */
export const sentences = (text: string) => text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

/**
 * Where `text` starts in `full`, when it is an exact part of it, or whole
 * sentences of it kept in order (a caption trimmed to its best sentences);
 * -1 otherwise.
 */
export function sentencesIn(full: string, text: string): number {
  const exact = full.indexOf(text);
  if (exact >= 0) return exact;
  let from = 0;
  let start = -1;
  for (const sentence of sentences(text)) {
    const at = full.indexOf(sentence, from);
    if (at < 0) return -1;
    if (start < 0) start = at;
    from = at + sentence.length;
  }
  return start;
}

/** A caption that uses its line's exact sentences and isn't a paragraph. */
export function goodCaption(full: string, text: string): boolean {
  const t = norm(text);
  return Boolean(t) && sentencesIn(norm(full), t) >= 0 && (t.split(' ').length <= MAX_CAPTION_WORDS || sentences(t).length === 1);
}

/**
 * What code can hold an adaptation to: captions and balloons use the story's
 * words exactly and in order, every line of dialogue keeps all its words, and
 * pages have a drawable shape. Returns one sentence per problem, written to
 * the adapter.
 */
export function adaptationProblems(adaptation: SceneAdaptation, lines: SceneLines, cast: Record<string, CastMember>): string[] {
  const problems: string[] = [];
  if (!adaptation.setting?.trim()) problems.push('The scene needs a "setting".');
  if (!adaptation.pages?.length) return [...problems, 'The scene has no pages.'];

  const drawable = new Set(Object.keys(cast).filter((id) => cast[id]!.look));
  const order = [...lines.keys()];
  const used = new Map<string, string[]>();
  let last = { line: -1, at: -1 };

  adaptation.pages.forEach((page, p) => {
    const where = `Page ${p + 1} of the scene`;
    const count = page.panels?.length ?? 0;
    const rows = page.rows ?? [];
    if (count < PANELS_PER_PAGE.min || count > PANELS_PER_PAGE.max) problems.push(`${where} has ${count} panels; a page holds ${PANELS_PER_PAGE.min} to ${PANELS_PER_PAGE.max}.`);
    if (rows.reduce((a, b) => a + b, 0) !== count) problems.push(`${where}: rows ${JSON.stringify(rows)} add up to ${rows.reduce((a, b) => a + b, 0)}, but the page has ${count} panels.`);
    if (rows.some((n) => n < PANELS_PER_ROW.min || n > PANELS_PER_ROW.max)) problems.push(`${where}: each row holds ${PANELS_PER_ROW.min} to ${PANELS_PER_ROW.max} panels.`);

    (page.panels ?? []).forEach((panel, i) => {
      const at = `${where}, panel ${i + 1}`;
      if (!panel.shot?.trim()) problems.push(`${at} needs a "shot".`);
      if (!panel.acting?.trim()) problems.push(`${at} needs an "acting" note.`);
      if (panel.continues && i === 0) problems.push(`${at} "continues", but it is the first panel on its page; a continuing panel follows one on the same page.`);
      for (const id of placed(panel)) if (!drawable.has(id)) problems.push(`${at} places ${id}, who is not a cast member with a look.`);
      const lettered = (panel.items ?? []).filter((item) => !('sfx' in item)).length;
      if (lettered > MAX_ITEMS_PER_PANEL) problems.push(`${at} has ${lettered} captions and balloons; at most ${MAX_ITEMS_PER_PANEL} fit. Split them across panels.`);
      const seen = placed(panel);
      if (new Set(seen).size !== seen.length) problems.push(`${at} places someone on two sides.`);

      for (const item of panel.items ?? []) {
        if ('sfx' in item) continue;
        const line = lines.get(item.line);
        if (!line) {
          problems.push(`${at} uses ${item.line}, which is not one of this scene's lines.`);
          continue;
        }
        const text = norm(item.text ?? line.display);
        const full = norm(line.display);
        const index = sentencesIn(full, text);
        if (!text || index < 0) {
          problems.push(`${at}: the text for ${item.line} is not an exact part of the line. Copy whole sentences from: "${line.display}"`);
          continue;
        }
        // One long sentence can't be trimmed to whole sentences; it stands.
        if (line.narration && text.split(' ').length > MAX_CAPTION_WORDS && sentences(text).length > 1) problems.push(`${at}: the caption from ${item.line} is ${text.split(' ').length} words; keep its best sentences, at most ${MAX_CAPTION_WORDS} words, with "text", and let the picture show the rest.`);
        const lineIndex = order.indexOf(item.line);
        if (lineIndex < last.line || (lineIndex === last.line && index < last.at)) problems.push(`${at}: ${item.line} comes out of story order.`);
        last = { line: lineIndex, at: index };
        used.set(item.line, [...(used.get(item.line) ?? []), text]);
      }
    });
  });

  // Staging: names everyone it stages with their side, and no panel flips them.
  const sides = new Map<string, { left: number; right: number }>();
  for (const page of adaptation.pages) {
    for (const panel of page.panels ?? []) {
      if (!panel.left?.length || !panel.right?.length) continue;
      for (const [side, ids] of [['left', panel.left], ['right', panel.right]] as const) {
        for (const id of ids) {
          const c = sides.get(id) ?? { left: 0, right: 0 };
          c[side]++;
          sides.set(id, c);
        }
      }
    }
  }
  const regulars = [...sides].filter(([, c]) => c.left + c.right >= 2).map(([id]) => id);
  if (adaptation.staging && regulars.length) {
    const named = (id: string) => new RegExp(`\\b${id.charAt(0)}${id.slice(1).toLowerCase().replace(/_/g, ' ')}\\b`, 'i').test(adaptation.staging!) || adaptation.staging!.includes(id);
    const missing = regulars.filter((id) => !named(id));
    if (missing.length) problems.push(`The staging must say where ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'}: which side of the frame, and which way they face.`);
    if (!/\b(left|right)\b/i.test(adaptation.staging)) problems.push('The staging must say who is on the left of the frame and who is on the right.');
    if (!/\bcamera\b/i.test(adaptation.staging)) problems.push('The staging must say where the camera is.');
  }
  for (const [id, c] of sides) {
    if (c.left && c.right) {
      const usual = c.left >= c.right ? 'left' : 'right';
      problems.push(`${id} switches sides: on the left in ${c.left} panels and the right in ${c.right}. Keep ${id} on the ${usual} whenever they share a panel with someone on the other side.`);
    }
  }

  // Every word of every line of dialogue, in order.
  for (const [id, line] of lines) {
    if (line.narration) continue;
    const want = words(line.display);
    const got = words((used.get(id) ?? []).join(' '));
    let k = 0;
    const missing: string[] = [];
    for (const w of want) {
      if (got[k] === w) k++;
      else missing.push(w);
    }
    if (missing.length) problems.push(`${line.speaker}'s line ${id} must appear in balloons with all its words; missing: "${missing.join(' ')}". The line: "${line.display}"`);
  }
  return problems;
}
