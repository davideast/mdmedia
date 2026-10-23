import { words } from '../diff.js';
import type { Line, StoryScript } from '../types.js';

/** The longest speech tag ("June called from the hallway") that may be dropped. */
export const MAX_TAG_WORDS = 6;

export interface MissingSpan {
  /** The author's words that no line says. */
  words: string[];
  /** The author's paragraph they came from. */
  paragraph: string;
  allowed: boolean;
  /** Why an allowed span is allowed. */
  reason?: 'speech-tag' | 'label' | 'replaced' | 'title';
}

export interface AddedSpan {
  words: string[];
  lineId: string;
  allowed: boolean;
}

export interface Fidelity {
  missing: MissingSpan[];
  added: AddedSpan[];
  /** The spans that are not allowed: cuts, rewordings, unmarked additions. */
  gaps: Array<MissingSpan | AddedSpan>;
}

/**
 * Checks that a story file keeps the author's words. The raw text's words are
 * compared in order with the words the script's lines speak. Allowed
 * differences: a dropped speech tag (up to MAX_TAG_WORDS words, in a paragraph
 * with a quotation), a dropped label such as "HARPER:" at the start of a
 * paragraph, the title, a sentence recorded in a `<!-- replaced: "…" -->`
 * comment that an added line follows, and lines marked
 * `<!-- director: added -->`. Everything else is a gap.
 */
export function fidelity(raw: string, markdown: string, script: StoryScript): Fidelity {
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^[-*_]{3,}$/.test(p));
  const rawWords: Array<{ word: string; paragraph: number }> = [];
  paragraphs.forEach((p, i) => words(p).forEach((word) => rawWords.push({ word, paragraph: i })));

  const lines = script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const marks = commentMarks(markdown, lines);
  const storyWords: Array<{ word: string; line: Line }> = [];
  for (const line of lines) for (const word of words(line.text)) storyWords.push({ word, line });

  const { missing: missingIdx, added: addedIdx } = alignment(rawWords.map((w) => w.word), storyWords.map((w) => w.word));

  // A missing run never spans two paragraphs, so each gap names one place.
  const byParagraph = runs(missingIdx).flatMap((run) => {
    const out: number[][] = [];
    for (const i of run) {
      const last = out.at(-1);
      if (last && rawWords[last.at(-1)!]!.paragraph === rawWords[i]!.paragraph) last.push(i);
      else out.push([i]);
    }
    return out;
  });
  const missing: MissingSpan[] = byParagraph.map((run) => {
    const spanWords = run.map((i) => rawWords[i]!.word);
    const paragraph = paragraphs[rawWords[run[0]!]!.paragraph]!;
    const reason = allowedReason(spanWords, paragraph, script, marks.replaced);
    return { words: spanWords, paragraph, allowed: Boolean(reason), ...(reason ? { reason } : {}) };
  });
  const added: AddedSpan[] = runs(addedIdx).map((run) => {
    const line = storyWords[run[0]!]!.line;
    return { words: run.map((i) => storyWords[i]!.word), lineId: line.id, allowed: marks.added.has(line.id) };
  });
  return { missing, added, gaps: [...missing, ...added].filter((s) => !s.allowed) };
}

function allowedReason(span: string[], paragraph: string, script: StoryScript, replaced: string[][]): MissingSpan['reason'] | undefined {
  const text = span.join(' ');
  if (words(script.meta.title).join(' ') === text) return 'title';
  if (/^[A-Z][A-Z .']*:/.test(paragraph) && words(paragraph.slice(0, paragraph.indexOf(':'))).join(' ') === text) return 'label';
  if (span.length <= MAX_TAG_WORDS && touchesQuotation(span, paragraph)) return 'speech-tag';
  if (replaced.some((r) => contains(r, span))) return 'replaced';
  return undefined;
}

/**
 * Reads the director's comments: lines marked `<!-- director: added -->` and
 * the text of `<!-- replaced: "…" -->` comments that an added line follows
 * within the next three lines.
 */
function commentMarks(markdown: string, lines: Line[]): { added: Set<string>; replaced: string[][] } {
  const added = new Set<string>();
  const replaced: string[][] = [];
  const sourceLines = markdown.split('\n');
  const lineAfter = (row: number) => lines.find((l) => l.source.line > row);
  sourceLines.forEach((text, i) => {
    const row = i + 1;
    if (/<!--\s*director:\s*added\s*-->/.test(text)) {
      const next = lineAfter(row);
      if (next) added.add(next.id);
    }
  });
  sourceLines.forEach((text, i) => {
    const match = /<!--\s*replaced:\s*"(.*)"[^"]*-->/.exec(text);
    if (!match) return;
    const after = lines.filter((l) => l.source.line > i + 1).slice(0, 3);
    if (after.some((l) => added.has(l.id))) replaced.push(words(match[1]!));
  });
  return { added, replaced };
}

/** Indexes of words only in `a` (missing) and only in `b` (added), by longest common subsequence. */
function alignment(a: string[], b: string[]): { missing: number[]; added: number[] } {
  const width = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1]! + 1 : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const missing: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j >= b.length || (i < a.length && dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) missing.push(i++);
    else added.push(j++);
  }
  return { missing, added };
}

/** Consecutive indexes grouped into runs. */
function runs(indexes: number[]): number[][] {
  const out: number[][] = [];
  for (const i of indexes) {
    const last = out.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else out.push([i]);
  }
  return out;
}

/**
 * A speech tag sits right next to a quotation: straight after a closing quote
 * ("Wait!" Maya shouted.) or straight before an opening one, after a comma or
 * colon (Then she said, "I'm still mad."). A beat such as "Dad laughed." does
 * not touch the quotation that follows it.
 */
function touchesQuotation(span: string[], paragraph: string): boolean {
  const pattern = new RegExp(span.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")).join("[^a-z0-9'’]+"), 'gi');
  for (const match of paragraph.matchAll(pattern)) {
    const before = paragraph.slice(0, match.index).trimEnd();
    const after = paragraph.slice(match.index + match[0].length).replace(/^[\s,:]+/, '');
    if (/["”]$/.test(before) || (/^["“]/.test(after) && /[,:]\s*["“]/.test(paragraph.slice(match.index + match[0].length, match.index + match[0].length + 4)))) return true;
  }
  return false;
}

function contains(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
