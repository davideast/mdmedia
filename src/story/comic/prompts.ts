import type { CastMember } from '../types.js';
import type { ComicItem, ComicPanel } from './types.js';

/**
 * How the art is asked for, as data. Each phrase is one the prototype found to
 * work (plans/story/prototype-findings.md, runs 3, 4 and 6).
 */

/** Style presets; any other `style:` value is used as written. */
export const STYLES: Record<string, string> = {
  flat:
    'Modern middle-grade graphic novel art: clean confident ink outlines, flat bright colors with soft cel shading, ' +
    'expressive cartoon faces and body language, warm and funny',
  watercolor:
    'Hand-drawn picture-book illustration: loose pen-and-ink linework with transparent watercolor washes, ' +
    'visible paper texture, soft warm palette, gentle and charming',
  manga:
    'Black-and-white manga: crisp inked lines, screentone shading, dynamic camera angles, ' +
    'big expressive manga reactions, speed lines for motion',
};

export const styleText = (style: string) => STYLES[style] ?? style;

/**
 * The page letters the panel, so the art must fill the image and hold no text.
 * Asking for space for balloons drew empty boxes; headroom works.
 */
export const BLEED =
  'One full-bleed illustration that fills the whole image edge to edge: no border, frame, boxes, panels or blank areas. ' +
  'No text anywhere: no speech balloons, captions, sound effects or lettering.';

export const isExtremeCloseUp = (panel: Pick<ComicPanel, 'shot'>) => /extreme close-up/i.test(panel.shot);

/** The cast id as a reader writes it: MILO → Milo, SEVENTH_GRADER → Seventh grader. */
export const displayName = (id: string) => (id.charAt(0) + id.slice(1).toLowerCase()).replace(/_/g, ' ');

const looks = (ids: string[], cast: Record<string, CastMember>) =>
  ids.filter((id) => cast[id]?.look).map((id) => `${displayName(id)}: ${cast[id]!.look}`).join('; ');

export function sheetPrompt(style: string, cast: Record<string, CastMember>): string {
  const ids = Object.keys(cast).filter((id) => cast[id]!.look);
  return (
    `${styleText(style)}. A character reference sheet on a plain light background: ${ids.length} characters standing side by side, ` +
    `full body, front view, neutral friendly poses, evenly spaced, no text or labels. From left to right: ${looks(ids, cast)}.`
  );
}

/**
 * The staging image's prompt. It carries who stands on which side, because
 * the panels drawn from it are placed that way: a staging image that put Milo
 * on the left while every panel said June was on the left gave each panel a
 * reference that contradicted its own text, and the art flipped from panel to
 * panel (adapted lunch scene).
 */
export function stagingPrompt(style: string, staging: string, cast: Record<string, CastMember>, ids: string[], placement: Record<string, 'left' | 'right'> = {}, rules?: string): string {
  const sides = placementText(placement);
  return [
    `${styleText(style)}. ${BLEED} ${staging}`,
    sides ? `Placement: ${sides}.` : '',
    rules ?? '',
    `Characters, drawn exactly as in the reference sheet: ${looks(ids, cast)}. They sit calmly.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** `{ JUNE: 'left', MILO: 'right' }` → `June on the left of the frame, Milo on the right of the frame` */
export function placementText(placement: Record<string, 'left' | 'right'>): string {
  return Object.entries(placement).map(([id, side]) => `${displayName(id)} on the ${side} of the frame`).join(', ');
}

/** The left/right question for a set of placements, or undefined when there aren't both sides. */
export function sidesQuestion(placement: Record<string, string>): string | undefined {
  const left = Object.entries(placement).filter(([, side]) => side === 'left').map(([id]) => displayName(id));
  const right = Object.entries(placement).filter(([, side]) => side === 'right').map(([id]) => displayName(id));
  return left.length && right.length ? `Is ${left.join(' and ')} on the left of the frame and ${right.join(' and ')} on the right?` : undefined;
}

/**
 * The hair from a look ("messy curly brown hair"), the detail that drifts
 * most between panels and that a broad on-model question let through (Milo
 * drawn with straight hair, adapted lunch scene).
 */
export function hairOf(look: string): string | undefined {
  const part = look.split(/[;,]/).find((p) => /\bhair\b|\bbob\b|\bbuzz cut\b|\bbald\b|\bbun\b/i.test(p));
  if (!part) return undefined;
  const after = /\bwith\s+(.*)$/i.exec(part);
  return (after ? after[1]! : part).split(/\s+and\s+(?:a|an)\s+/i)[0]!.replace(/^\s*(?:a|an)\s+/i, '').trim() || undefined;
}

/** Whose look a staging text mentions, by name. */
export function namedIn(text: string, cast: Record<string, CastMember>): string[] {
  return Object.keys(cast).filter((id) => cast[id]!.look && new RegExp(`\\b${displayName(id)}\\b`, 'i').test(text));
}

export type Reference = 'sheet' | 'staging' | 'previous';

const LEGEND: Record<Reference, string> = {
  sheet: 'the character sheet (match faces, hair and clothes exactly)',
  staging: 'the staging of this scene (match the room, the seats and who sits where)',
  previous: 'the panel just before this one (keep continuity with it)',
};

function dialogue(items: ComicItem[]): string {
  return items
    .filter((i) => i.kind !== 'sfx')
    .map((i) => (i.kind === 'caption' ? `(narrating) "${i.text}"` : i.kind === 'balloon' ? `${displayName(i.who)} says "${i.text}"` : ''))
    .join(' ');
}

/** The prompt for one panel. `previous` gives the dialogue just before, for context only. */
export function panelPrompt(panel: ComicPanel, style: string, cast: Record<string, CastMember>, references: Reference[], previous?: ComicPanel): string {
  if (panel.continues) {
    return `Edit this comic panel. ${panel.acting || panel.shot} Keep everything else identical. ${BLEED}`;
  }
  const framing = isExtremeCloseUp(panel)
    ? 'Framing: extreme close-up; the face fills the frame edge to edge, no body or room visible.'
    : panel.zone === 'top'
      ? 'Framing: generous headroom; the top quarter of the image shows only background scenery such as ceiling, wall or banners, with no faces there.'
      : 'Framing: generous foot room; the bottom quarter shows only floor or table, with no faces there.';
  const who = looks(Object.keys(panel.positions), cast);
  const placement = Object.entries(panel.positions).map(([id, side]) => `${displayName(id)} on the ${side} of the frame`).join(', ');
  return [
    `${styleText(style)}. ${BLEED}`,
    panel.shot,
    panel.acting,
    panel.rules ?? '',
    who ? `Characters: ${who}.` : '',
    placement ? `Placement: ${placement}.` : '',
    panel.setting ? `Setting: ${panel.setting}.` : '',
    framing,
    `In this moment: ${dialogue(panel.items) || 'no one speaks'}. Just before: ${previous ? dialogue(previous.items) || 'nothing' : 'nothing'}. Draw the moment; do not write any of these words.`,
    references.length ? `Reference images: ${references.map((r, i) => `reference ${i + 1} is ${LEGEND[r]}`).join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';

/**
 * A look as a checker needs it: hair, clothes and props, without ages or body
 * details. Gemini blocks a request (PROHIBITED_CONTENT) that describes a
 * fourteen-year-old's age and body ("wiry", "scraped knees") beside an image
 * of her; the same request asking only for her hair and jacket answers
 * (Midnight Line, panels 1.1 and 2.4). Recognizing someone needs neither.
 */
export function visualLook(look: string): string {
  return look
    .replace(new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})-year-old\\b`, 'gi'), '')
    .replace(/\b(?:scraped|bare|skinned) (?:knees|legs)\b,?/gi, '')
    .replace(/\b(?:wiry|skinny|small|tiny|lanky|tall|bony|thin)\b(?=[\s,])/gi, '')
    .replace(/\s+([,;])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/\b(an?),\s*/gi, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * On-model questions for the characters in an image, from their looks. Only
 * what identifies a character is judged: asking about every detail failed
 * drawings over scraped knees and shoelaces (Midnight Line run).
 */
export function onModelQuestions(ids: string[], cast: Record<string, CastMember>): string[] {
  return ids
    .filter((id) => cast[id]?.look)
    .map(
      (id) =>
        `Is ${displayName(id)} recognizably this character, judging only hair, face and main outfit as far as they are visible ` +
        `(ignore small details such as shoes, accessories or marks): ${visualLook(cast[id]!.look!)}?`
    )
    .concat(
      ids
        .filter((id) => cast[id]?.look && hairOf(cast[id]!.look!))
        .map((id) => `Does ${displayName(id)} have ${hairOf(cast[id]!.look!)}, as far as it is visible?`)
    );
}

export const NO_TEXT_QUESTION =
  'Is the image free of speech balloons, captions and written words (apart from signs, banners and labels on objects such as milk cartons)?';

/** The model sometimes draws its own panel divider inside the image (live run, panel 1.4). */
export const ONE_IMAGE_QUESTION = 'Is this one unbroken picture, with no panel borders, frames or dividing lines drawn across it?';

/**
 * The yes/no questions a drawn panel must pass. Generated from the panel and
 * the cast; a check only catches what it asks (prototype run 6).
 */
export function panelQuestions(panel: ComicPanel, cast: Record<string, CastMember>): string[] {
  const questions = [...onModelQuestions(Object.keys(panel.positions), cast), NO_TEXT_QUESTION, ONE_IMAGE_QUESTION];
  const sides = sidesQuestion(panel.positions);
  if (sides) questions.push(sides);
  if (isExtremeCloseUp(panel)) questions.push('Is this an extreme close-up where one face fills nearly the whole frame?');
  if (panel.continues) questions.push('Is this the same framing and the same face as the previous panel shown?');
  if (panel.acting) questions.push(`Does the panel show this moment, in pose and expression: ${panel.acting}`);
  return questions;
}
