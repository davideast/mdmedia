import type { SourceRange } from './types.js';

/** Maps character offsets in a text to 1-based lines and columns. */
export class SourceMap {
  private readonly lineStarts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  position(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1 };
  }

  range(start: number, end: number): SourceRange {
    const a = this.position(start);
    const b = this.position(Math.max(start, end));
    return { line: a.line, column: a.column, endLine: b.line, endColumn: b.column };
  }
}

export function toSourceRange(text: string, start: number, end: number): SourceRange {
  return new SourceMap(text).range(start, end);
}

/**
 * Parses `1.5s`, `1500ms` or `0:02` into milliseconds. Returns undefined for
 * anything else. Zero is allowed: `0ms` removes the gap, as for an
 * interruption.
 */
export function parseDuration(text: string): number | undefined {
  const value = text.trim();
  let ms: number | undefined;
  let match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (match) ms = Number(match[1]) * 1000;
  match = /^(\d+)ms$/.exec(value);
  if (match) ms = Number(match[1]);
  match = /^(\d+):([0-5]\d)$/.exec(value);
  if (match) ms = (Number(match[1]) * 60 + Number(match[2])) * 1000;
  if (ms === undefined || !(ms >= 0)) return undefined;
  return Math.round(ms);
}
