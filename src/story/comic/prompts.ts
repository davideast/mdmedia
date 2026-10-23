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

export function stagingPrompt(style: string, staging: string, cast: Record<string, CastMember>, ids: string[]): string {
  return `${styleText(style)}. ${BLEED} ${staging} Characters, drawn exactly as in the reference sheet: ${looks(ids, cast)}. They sit calmly.`;
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

/** On-model questions for the characters in an image, from their looks. */
export function onModelQuestions(ids: string[], cast: Record<string, CastMember>): string[] {
  return ids
    .filter((id) => cast[id]?.look)
    .map((id) => `Does ${displayName(id)} match this description, as far as they are visible: ${cast[id]!.look}?`);
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
  const left = Object.entries(panel.positions).filter(([, side]) => side === 'left').map(([id]) => displayName(id));
  const right = Object.entries(panel.positions).filter(([, side]) => side === 'right').map(([id]) => displayName(id));
  if (left.length && right.length) questions.push(`Is ${left.join(' and ')} on the left of the frame and ${right.join(' and ')} on the right?`);
  if (isExtremeCloseUp(panel)) questions.push('Is this an extreme close-up where one face fills nearly the whole frame?');
  if (panel.continues) questions.push('Is this the same framing and the same face as the previous panel shown?');
  if (panel.acting) questions.push(`Does the panel show this moment, in pose and expression: ${panel.acting}`);
  return questions;
}
