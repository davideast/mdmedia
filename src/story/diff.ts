import type { LineCheck } from './ports.js';

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bkinda\b/g, 'kind of'],
  [/\b([a-z]+)'ve\b/g, '$1 have'],
  // The elided 'd ("he'd") is heard either way, so it is dropped on both sides.
  [/\b([a-z]+)'d\b/g, '$1'],
  [/\bper cent\b/g, 'percent'],
  [/%/g, ' percent'],
];

/** Abbreviations a transcriber writes for words a script spells out. */
const UNITS: Record<string, string> = { ft: 'feet', mr: 'mister', mrs: 'missus', dr: 'doctor' };

/**
 * Ordinals as a number and a marker, so "one hundredth" matches "100th" (a
 * transcriber writes digits). "second" is left alone: it is usually time.
 */
const ORDINAL_WORDS: Record<string, string> = {
  first: 'one', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve',
  hundredth: 'hundred', thousandth: 'thousand',
};
function ordinal(word: string): string[] {
  const digits = /^(\d+)(st|nd|rd|th)$/.exec(word);
  if (digits) return [digits[1]!, 'th'];
  if (word in ORDINAL_WORDS) return [ORDINAL_WORDS[word]!, 'th'];
  if (word.endsWith('ieth') && word.slice(0, -4) + 'y' in TENS) return [word.slice(0, -4) + 'y', 'th'];
  if (word.endsWith('th') && word.slice(0, -2) in SMALL) return [word.slice(0, -2), 'th'];
  return [word];
}

/**
 * Non-lexical sounds a voice often performs (a laugh, a sigh) instead of
 * saying, so a transcript leaves them out. Missing ones are noise; added ones
 * are not ("Ugh. You promised." was a real defect in the prototype).
 */
export const INTERJECTIONS: ReadonlySet<string> = new Set(['heh', 'hah', 'ha', 'hmm', 'mm', 'huh', 'uh', 'um', 'er', 'ah']);

/** Lower case, no punctuation, contractions spelled out, numbers as digits. */
export function words(text: string): string[] {
  let t = text.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [pattern, replacement] of CONTRACTIONS) t = t.replace(pattern, replacement);
  const tokens = t
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map((w) => UNITS[w] ?? w)
    .flatMap(ordinal);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const number = readNumber(tokens, i);
    if (number) { out.push(String(number.value)); i = number.next; }
    else out.push(tokens[i++]!);
  }
  return out;
}

/**
 * Reads one spelled-out number starting at `i`: "forty five", "three
 * hundred", "two hundred and twelve", "twelve thousand". Separate numbers stay
 * separate ("eleven twelve" is two numbers).
 */
function readNumber(tokens: string[], i: number): { value: number; next: number } | undefined {
  const below100 = (at: number): { value: number; next: number } | undefined => {
    const w = tokens[at];
    if (w === undefined) return undefined;
    if (w in TENS) {
      const unit = tokens[at + 1];
      if (unit !== undefined && unit in SMALL && SMALL[unit]! > 0 && SMALL[unit]! < 10) return { value: TENS[w]! + SMALL[unit]!, next: at + 2 };
      return { value: TENS[w]!, next: at + 1 };
    }
    if (w in SMALL) return { value: SMALL[w]!, next: at + 1 };
    return undefined;
  };
  const below1000 = (at: number): { value: number; next: number } | undefined => {
    const first = below100(at);
    if (!first || tokens[first.next] !== 'hundred') {
      if (tokens[at] === 'hundred') return withRest(100, at + 1);
      return first;
    }
    return withRest(first.value * 100, first.next + 1);
  };
  const withRest = (value: number, at: number) => {
    const skipAnd = tokens[at] === 'and' ? at + 1 : at;
    const rest = below100(skipAnd);
    return rest ? { value: value + rest.value, next: rest.next } : { value, next: at };
  };

  const head = below1000(i);
  if (!head) return undefined;
  if (tokens[head.next] !== 'thousand') return head;
  const thousands = head.value * 1000;
  const at = tokens[head.next + 1] === 'and' ? head.next + 2 : head.next + 1;
  const tail = below1000(at);
  return tail ? { value: thousands + tail.value, next: tail.next } : { value: thousands, next: head.next + 1 };
}

/**
 * Compares what a line says with what was heard in its clip. Words that differ
 * only by spacing ("lawn mower" and "lawnmower") match, and a missing
 * interjection alone does not fail the line. Returns the words the clip is
 * missing and the words it added.
 */
export function compareTranscript(expected: string, heard: string): LineCheck {
  const want = words(expected);
  const got = words(heard);
  const dp = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      dp[i]![j] = want[i] === got[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const missing: string[] = [];
  const extra: string[] = [];
  let i = 0;
  let j = 0;
  while (i < want.length || j < got.length) {
    if (i < want.length && j < got.length && want[i] === got[j]) { i++; j++; continue; }
    // Same letters, different spacing: compare a few words joined together.
    const joined = joinedMatch(want, i, got, j);
    if (joined) { i += joined[0]; j += joined[1]; continue; }
    if (j >= got.length || (i < want.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) missing.push(want[i++]!);
    else extra.push(got[j++]!);
  }
  const onlyInterjectionsMissing = extra.length === 0 && missing.every((w) => INTERJECTIONS.has(w));
  return { heard, missing, extra, ok: onlyInterjectionsMissing };
}

function joinedMatch(want: string[], i: number, got: string[], j: number): [number, number] | undefined {
  for (let a = 1; a <= 3 && i + a <= want.length; a++) {
    for (let b = 1; b <= 3 && j + b <= got.length; b++) {
      if (a === 1 && b === 1) continue;
      if (want.slice(i, i + a).join('') === got.slice(j, j + b).join('')) return [a, b];
    }
  }
  return undefined;
}
