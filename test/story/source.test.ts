import { describe, expect, it } from 'bun:test';
import { parseDuration, toSourceRange } from '../../src/story/source.js';

describe('parseDuration', () => {
  it('reads seconds, milliseconds and minutes', () => {
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('2s')).toBe(2000);
    expect(parseDuration('1500ms')).toBe(1500);
    expect(parseDuration('0:02')).toBe(2000);
    expect(parseDuration('1:30')).toBe(90_000);
    expect(parseDuration('  400ms\n')).toBe(400);
  });

  it('allows zero, which removes the gap', () => {
    expect(parseDuration('0ms')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
  });

  it('rejects anything else', () => {
    for (const bad of ['soon', '', '1.5', '-1s', '1m', '1:60', '1.5ms', 's']) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });
});

describe('toSourceRange', () => {
  it('gives 1-based lines and columns', () => {
    const text = 'ab\ncde\nf';
    expect(toSourceRange(text, 0, 2)).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 3 });
    expect(toSourceRange(text, 3, 6)).toEqual({ line: 2, column: 1, endLine: 2, endColumn: 4 });
    expect(toSourceRange(text, 7, 8)).toEqual({ line: 3, column: 1, endLine: 3, endColumn: 2 });
  });
});
