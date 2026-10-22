import { contextLines } from './key.js';
import type { Line, StoryScript } from './types.js';

/**
 * How far to fall back when the provider refuses a request: 0 is the full
 * note, 1 the line's cue alone, 2 no note at all.
 */
export type NoteLevel = 0 | 1 | 2;
export const NOTE_LEVELS: readonly NoteLevel[] = [0, 1, 2];

/**
 * The delivery note for one line: the character's usual delivery, the line's
 * cue, and what was said just before it in the same scene. It is sent apart
 * from the words, so it is never spoken.
 */
export function deliveryNote(line: Line, script: StoryScript, level: NoteLevel): string {
  if (level === 2) return '';
  if (level === 1) return line.cue;
  const speaker = script.cast[line.speaker];
  const before = contextLines(line, script);
  const context = before.length
    ? 'Just before this, in the same scene: ' + before.map((l) => `${l.speaker} said "${l.text}"`).join(' Then ') + '.'
    : '';
  return [speaker?.delivery ?? '', line.narration ? 'narrating' : '', line.cue, context]
    .map((part) => part.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .join('. ');
}
