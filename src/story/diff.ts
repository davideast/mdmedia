import type { LineCheck } from './ports.js';

const NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100',
};
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bkinda\b/g, 'kind of'],
];

/** Lower case, no punctuation, contractions spelled out, numbers as digits. */
export function words(text: string): string[] {
  let t = text.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [pattern, replacement] of CONTRACTIONS) t = t.replace(pattern, replacement);
  return t
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map((w) => NUMBERS[w] ?? w);
}

/**
 * Compares what a line says with what was heard in its clip. Words that differ
 * only by spacing ("lawn mower" and "lawnmower") match. Returns the words the
 * clip is missing and the words it added.
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
  return { heard, missing, extra, ok: missing.length === 0 && extra.length === 0 };
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
