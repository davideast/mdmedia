import { StoryError, type CastId, type StoryScript, type VoiceRef } from './types.js';

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, 'giu');

/**
 * The words the voice is given: each `pronounce:` word replaced by its
 * respelling, so "Nerw" is said "Nur-oo". The script keeps the real spelling
 * for display, lettering and the transcript check.
 */
export function spokenText(text: string, pronounce: Record<string, string> | undefined): string {
  let out = text;
  for (const [word, say] of Object.entries(pronounce ?? {})) out = out.replace(wordPattern(word), say);
  return out;
}

/**
 * What was heard, with respellings turned back into the story's words, so a
 * transcriber that writes "Nur-oo", "Nuroo" or "Nur oo" matches "Nerw".
 */
export function heardAsWritten(heard: string, pronounce: Record<string, string> | undefined): string {
  let out = heard;
  for (const [word, say] of Object.entries(pronounce ?? {})) {
    const parts = say.split(/[\s-]+/).filter(Boolean).map(escape);
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s-]*')}(?![\\p{L}\\p{N}])`, 'giu'), word);
  }
  return out;
}

/**
 * The voice a cast member speaks with: their own, or the voice of the cast
 * member it names (`voice: WREN`). Undefined when it has not been cast yet.
 */
export function voiceOf(script: Pick<StoryScript, 'cast'>, id: CastId): VoiceRef | undefined {
  const seen = new Set<CastId>();
  let current: CastId | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const voice: VoiceRef | undefined = script.cast[current]?.voice;
    if (typeof voice === 'string' && script.cast[voice]) current = voice;
    else return voice;
  }
  return undefined;
}

/** voiceOf, for rendering: a line can't be voiced by a cast member without a voice. */
export function requireVoice(script: Pick<StoryScript, 'cast'>, id: CastId): VoiceRef {
  const voice = voiceOf(script, id);
  if (!voice) throw new StoryError('uncast', `${id} has no voice yet: give them a voice:, or cast from their brief.`);
  return voice;
}
