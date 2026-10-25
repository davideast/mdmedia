import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { readCutFile, readWordsFile } from '../cut/align.js';
import { resolveCut } from '../cut/resolve.js';
import { applyWords } from '../cut/words.js';
import type { Timeline } from '../cut/types.js';
import { anchorItems, itemSpan, lineGaps, linePlace } from './anchor.js';

const CUTS = path.join(import.meta.dir, '..', '..', 'docs', 'cuts');

/** Big Hal Take 5 with its words applied, as Studio's loader merges them (contents unchecked: no media needed). */
async function bigHal(): Promise<Timeline> {
  const cut = await readCutFile(path.join(CUTS, 'big-hal-take5.cut.json'));
  const words = await readWordsFile(path.join(CUTS, 'big-hal-take5.words.json'));
  if (!words) throw new Error('no words file');
  const merge = applyWords(cut, words, { root: '/media' });
  expect(merge.stale).toEqual([]);
  const resolved = resolveCut(merge.cut, { root: '/media' });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  return resolved.value;
}

describe('thread anchors on Big Hal Take 5', () => {
  it('14.3 s is in PERSONALLY!, just after the pause, over the hood-pat insert', async () => {
    const timeline = await bigHal();
    // PERSONALLY! is its own line now (not a sound effect), and its first word starts at 14.28.
    expect(linePlace(timeline, 14.3)).toMatchObject({ in: 'line', line: 'personally', before: 'every', gapBefore: { id: 'every-personally' } });
    expect(linePlace(timeline, 14.2)).toMatchObject({ in: 'gap', gap: { id: 'every-personally', from: 'every', to: 'personally' } });
    expect(anchorItems(timeline, 14.3)).toEqual([
      { kind: 'segment', id: 'pat' },
      { kind: 'line', id: 'every' },
      { kind: 'line', id: 'personally' },
      { kind: 'gap', id: 'every-personally' },
    ]);
    // "by me!" ends in the medium shot; the insert starts at 14.0, before the word.
    expect(itemSpan(timeline, { kind: 'segment', id: 'pat' })).toMatchObject({ start: 14, end: 15.43 });
    expect(itemSpan(timeline, { kind: 'gap', id: 'every-personally' })).toEqual(
      expect.objectContaining({ start: 13.84, end: 14.28, length: 0.44 }),
    );
  });

  it('21.8 s is in "Wheels!", after the pause that follows "comes with..."', async () => {
    const timeline = await bigHal();
    expect(linePlace(timeline, 21.8)).toMatchObject({ in: 'line', line: 'wheels', before: 'thisone' });
    expect(anchorItems(timeline, 21.8)).toEqual([
      { kind: 'segment', id: 'finish' },
      { kind: 'line', id: 'thisone' },
      { kind: 'line', id: 'wheels' },
      { kind: 'gap', id: 'thisone-wheels' },
      { kind: 'overlay', id: 'included' },
      { kind: 'overlay', id: 'fine' },
    ]);
    const gap = lineGaps(timeline).find((g) => g.id === 'thisone-wheels');
    expect(gap).toMatchObject({ start: 20.79, end: 21.68, length: 0.89 });
    // The cut between the two shots falls inside that pause.
    const finish = itemSpan(timeline, { kind: 'segment', id: 'finish' });
    expect(finish?.start).toBe(21.13);
  });

  it('times lines by their speech, not their audio', async () => {
    const timeline = await bigHal();
    // The "personally" line is timed from its first word to its last: 14.28 to 14.98.
    expect(itemSpan(timeline, { kind: 'line', id: 'personally' })).toEqual({ start: 14.28, end: 14.98 });
    expect(anchorItems(timeline, 14.3).some((r) => r.kind === 'line' && r.id === 'personally')).toBe(true);
    expect(linePlace(timeline, 14.4)).toMatchObject({ in: 'line', line: 'personally', before: 'every' });
    // After its last word, the pause before "They start!".
    expect(linePlace(timeline, 15.0)).toMatchObject({ in: 'gap', gap: { from: 'personally' } });
  });
});
