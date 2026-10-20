import { describeDelivery, type LineMeasure, type MeasuredCheck, type ReferenceLevels } from './check.js';
import type { ResolvedLine, ResolvedPerformance, Timeline } from './types.js';

/**
 * The storyboard helper: writes a shot's delivery context into a storyboard
 * in the CRT TV house format, from the cut, its performances and its measured
 * check. A shot always carries a whole performance, never part of a
 * sentence, and it is told what was just said (verbatim, and how it was
 * delivered, measured), how to deliver its own lines, and what comes next.
 * Pure: the caller reads the files.
 */

/**
 * What a character's delivery profile adds to a storyboard: their register
 * and their "never" rules. The cast supplies it (`StoryboardInput.character`);
 * until then a storyboard has the performance's and the lines' directions
 * only.
 */
export interface CharacterDelivery {
  /** E.g. "a proud, sincere, steady local pitchman". */
  register?: string;
  /** E.g. ["never shouts", "never winks"]. */
  never?: string[];
  /** Measured from approved lines; the ranges are used by `mdmedia cut check`. */
  reference?: ReferenceLevels;
  /** The medians of the approved lines, written into the storyboard as the character's usual delivery. */
  typical?: { loudness: number | null; pitch: number | null; pitchRange: number | null; rate: number | null };
  /** How they look, in the words every storyboard should use, and what they never look like. */
  look?: { description: string; never: string[] };
  /** The character version, e.g. `big-hal@1`, for the notes (never written into the storyboard itself). */
  ref?: string;
}

export type CharacterFor = (speaker: string) => CharacterDelivery | undefined;

export interface StoryboardInput {
  timeline: Timeline;
  /** A line id or a performance id. A line in a performance brings its whole performance. */
  target: string;
  /** The cut's measured check, to describe how the words before were delivered. */
  measured?: MeasuredCheck | null;
  /** An existing storyboard whose title, look and framing paragraphs are kept (everything before its "Where this sits" paragraph, or its first two paragraphs). */
  base?: string | null;
  /** What the cut is, for "Where this sits in the …": default "scene", or what the base storyboard says. */
  setting?: string;
  character?: CharacterFor;
  /** Other speakers (cast roles) seen in the shot, whose look is written in too. */
  inShot?: string[];
}

export interface StoryboardResult {
  markdown: string;
  /** The shot's lines. */
  lines: string[];
  /** Its performance, or null for a line in none. */
  performance: string | null;
  /** The lines just said before it, and the line after it. */
  previous: string[];
  next: string | null;
  /** Seconds of speech in the shot, from its words (null without them). */
  speech: number | null;
  /** Things worth knowing, e.g. that a line brought its whole performance. */
  notes: string[];
}

/** About the longest sentence one generation holds. */
export const ONE_GENERATION_SECONDS = 7;

function speechSpan(line: ResolvedLine): { start: number; end: number } {
  if (line.words.length === 0) return { start: line.start, end: line.end };
  return { start: Math.min(...line.words.map((w) => w.start)), end: Math.max(...line.words.map((w) => w.end)) };
}

function performanceOf(timeline: Timeline, lineId: string): ResolvedPerformance | undefined {
  return timeline.performances.find((p) => p.lines.includes(lineId));
}

function linesOf(timeline: Timeline, ids: readonly string[]): ResolvedLine[] {
  return ids.map((id) => timeline.lines.find((l) => l.id === id)).filter((l): l is ResolvedLine => l !== undefined);
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function sentence(text: string): string {
  const t = capitalize(text.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Several measured lines as one: their median loudness and pitch, their widest range, their overall rate. */
function combine(measures: LineMeasure[]): Pick<LineMeasure, 'loudness' | 'pitch' | 'rate'> {
  if (measures.length === 1) return measures[0];
  const mid = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const loud = mid(measures.map((m) => m.loudness).filter((x): x is number => x !== null));
  const pitched = measures.filter((m) => m.pitch !== null);
  const pitch = pitched.length === 0 ? null : {
    median: mid(pitched.map((m) => m.pitch?.median ?? 0)) ?? 0,
    low: Math.min(...pitched.map((m) => m.pitch?.low ?? 0)),
    high: Math.max(...pitched.map((m) => m.pitch?.high ?? 0)),
    range: Math.max(...pitched.map((m) => m.pitch?.range ?? 0)),
    voiced: 0,
  };
  const timed = measures.filter((m) => m.rate !== null && m.timedBy === 'words');
  const words = timed.reduce((n, m) => n + m.words, 0);
  const seconds = timed.reduce((n, m) => n + (m.speech.end - m.speech.start), 0);
  const rate = seconds > 0 ? { words: Math.round((words / seconds) * 100) / 100, syllables: 0 } : null;
  return { loudness: loud === null ? null : Math.round(loud * 10) / 10, pitch, rate };
}

function quoteAll(lines: ResolvedLine[]): string {
  return lines.map((l) => `"${l.text}"`).join(' ');
}

/** The base storyboard's head (title, look, framing) and the setting its "Where this sits in the …" names. */
function baseParts(base: string): { title: string | null; paragraphs: string[]; setting: string | null } {
  const blocks = base.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
  const title = blocks[0]?.startsWith('# ') ? blocks[0] : null;
  const body = title ? blocks.slice(1) : blocks;
  const where = body.findIndex((b) => /^Where this sits\b/.test(b));
  const setting = where >= 0 ? (/^Where this sits in (?:the |a |an )?([^:]+):/.exec(body[where])?.[1] ?? null) : null;
  const head = where >= 0 ? body.slice(0, where) : body.slice(0, 2);
  return { title, paragraphs: head, setting };
}

/**
 * A character's usual delivery in words, from the medians of their approved
 * lines: "projected level, 3.07 words/s". Only loudness and pace: pitch
 * tracked on these voices reads wide ranges and octave slips, so in words it
 * would tell a video model the wrong thing (a steady pitchman as "very
 * animated"); pitch stays a number for `cut check`.
 */
export function describeTypical(typical: NonNullable<CharacterDelivery['typical']>): string {
  return describeDelivery({ loudness: typical.loudness, pitch: null, rate: typical.rate === null ? null : { words: typical.rate, syllables: 0 } });
}

function trimStop(text: string): string {
  return text.trim().replace(/[.;]$/, '');
}

/** The look paragraph for each character in the shot that has one. */
function lookParagraphs(roles: readonly string[], character: CharacterFor | undefined, notes: string[]): string[] {
  const out: string[] = [];
  for (const role of roles) {
    const profile = character?.(role);
    if (!profile?.look) continue;
    const never = profile.look.never.length > 0 ? ` Never shown with: ${profile.look.never.map(trimStop).join('; ')}.` : '';
    out.push(`${role} looks exactly like this, as in the first frame: ${trimStop(profile.look.description)}.${never}`);
    if (profile.ref) notes.push(`${role}'s look and delivery are from ${profile.ref}`);
  }
  return out;
}

/**
 * Writes the storyboard for the shot that carries `target`: its title, the
 * look and framing (from `base`, or placeholders to fill in), the delivery
 * context, the delivery itself, and a placeholder for its one action.
 */
export function buildStoryboard(input: StoryboardInput): StoryboardResult {
  const { timeline } = input;
  const notes: string[] = [];
  let performance = timeline.performances.find((p) => p.id === input.target) ?? null;
  if (!performance) {
    const line = timeline.lines.find((l) => l.id === input.target);
    if (!line) throw new Error(`The cut has no line or performance called "${input.target}"`);
    performance = performanceOf(timeline, line.id) ?? null;
    if (performance && performance.lines.length > 1) {
      notes.push(`${line.id} is in the performance ${performance.id}, so the shot carries all of it (${performance.lines.join(', ')}): never part of a sentence`);
    }
  }
  const shot = performance ? linesOf(timeline, performance.lines) : linesOf(timeline, [input.target]);
  const speaker = shot[0].speaker;
  const others = [...new Set(shot.map((l) => l.speaker))].filter((s) => s !== speaker);
  if (others.length > 0) notes.push(`its lines have more than one speaker (${[speaker, ...others].join(', ')}); a shot should have at most one`);
  const first = speechSpan(shot[0]);
  const last = speechSpan(shot[shot.length - 1]);
  const speech = shot.every((l) => l.words.length > 0) ? Math.round((last.end - first.start) * 100) / 100 : null;
  if (speech !== null && speech > ONE_GENERATION_SECONDS) {
    notes.push(`its speech runs ${speech} s; one generation holds a sentence of about ${ONE_GENERATION_SECONDS} s, so if the picture must change, cut it over this one take's sound, never the voice`);
  }

  // What was just said: the line before, or the whole performance it ends.
  const sorted = [...timeline.lines].filter((l) => !l.sung).sort((a, b) => speechSpan(a).start - speechSpan(b).start);
  const shotIds = new Set(shot.map((l) => l.id));
  const before = sorted.filter((l) => !shotIds.has(l.id) && speechSpan(l).end <= first.start + 1e-6);
  const justBefore = before[before.length - 1];
  let previous: ResolvedLine[] = [];
  if (justBefore) {
    const p = performanceOf(timeline, justBefore.id);
    previous = p ? linesOf(timeline, p.lines).filter((l) => speechSpan(l).end <= first.start + 1e-6) : [justBefore];
  }
  const after = sorted.find((l) => !shotIds.has(l.id) && speechSpan(l).start >= last.end - 1e-6) ?? null;

  const base = input.base ? baseParts(input.base) : null;
  const setting = input.setting ?? base?.setting ?? 'scene';
  const intent = performance?.intent ?? null;
  const summary = shot.map((l) => l.text).join(' ');
  const shortText = summary.length > 60 ? `${summary.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…` : summary;
  const title = `# ${timeline.meta.title}: ${shortText}${intent ? ` (${intent})` : ''}`;
  if (base?.title) notes.push(`the title is new; the base storyboard's was ${JSON.stringify(base.title.slice(2))}`);

  const looks = lookParagraphs([...new Set([speaker, ...(input.inShot ?? [])])], input.character, notes);
  const head = base && base.paragraphs.length > 0
    ? [...base.paragraphs, ...looks]
    : [
        '[The look: the era and format, the light, and the negatives: no captions, no subtitles, no on-screen text, no music, real physics, normal speed, no slow motion. Nothing morphs.]',
        '[The shot: the same shot as the first frame, how the camera is set, the framing, who is in it and where. Exactly one speaker.]',
        ...looks,
      ];

  // Where this sits.
  const where: string[] = [];
  if (previous.length > 0) {
    const measured = input.measured?.lines.filter((m) => previous.some((l) => l.id === m.id)) ?? [];
    const prevSpeaker = previous[0].speaker;
    const sameVoice = input.measured?.lines.filter((m) => m.speaker === prevSpeaker) ?? [];
    const how = measured.length > 0 ? describeDelivery(combine(measured), sameVoice) : '';
    if (measured.length === 0) notes.push('no measured check for the lines before it: run mdmedia cut check to describe how they were delivered');
    where.push(`in the shot just before this one ${prevSpeaker} has said ${quoteAll(previous)}${how ? `, ${how}` : ''}.`);
    where.push(prevSpeaker === speaker ? 'This shot is the next sentence, in exactly that same voice.' : `This shot answers it.`);
  } else {
    where.push(`this shot opens the ${setting}.`);
  }
  if (after) {
    where.push(`Right after this shot, in the next shot, ${after.speaker === speaker ? `${speaker} goes on` : `${after.speaker} says`}: "${after.text}"`);
  } else {
    where.push('Nothing comes after this shot.');
  }
  const context = `Where this sits in the ${setting}: ${where.join(' ')}`;

  // The delivery.
  const profile = input.character?.(speaker);
  const delivery: string[] = [`Only ${speaker} speaks${profile?.register ? `, ${profile.register}` : ''}.`];
  delivery.push(`${speaker} says once, word for word, each word once, with no stumble and no repeated word${shot.length > 1 ? ', all of it as one continuous delivery in one take' : ''}: ${quoteAll(shot)}`);
  if (performance?.delivery) delivery.push(sentence(performance.delivery));
  for (const l of shot) if (l.delivery) delivery.push(`On "${l.text}": ${l.delivery.replace(/\.$/, '')}.`);
  if (profile?.never && profile.never.length > 0) delivery.push(`${speaker} ${profile.never.map((n) => n.replace(/\.$/, '')).join(', ')}.`);
  if (profile?.typical) {
    const usual = describeTypical(profile.typical);
    if (usual) delivery.push(`${speaker}'s usual delivery, as in the approved lines: ${usual}.`);
  }
  delivery.push(`Then ${speaker} stops talking and holds, mouth closed. ${speaker} does not say anything else.`);

  const action = '[One simple action: what the hands or body do, timed to a word, with explicit negatives (never waves, never points, arms never go wide).]';
  const markdown = `${[title, ...head, context, delivery.join(' '), action].join('\n\n')}\n`;
  return {
    markdown,
    lines: shot.map((l) => l.id),
    performance: performance?.id ?? null,
    previous: previous.map((l) => l.id),
    next: after?.id ?? null,
    speech,
    notes,
  };
}
