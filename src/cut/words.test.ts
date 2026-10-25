import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CUT_FORMAT,
  WORDS_FORMAT,
  applyWords,
  checkEntry,
  countWords,
  fingerprintOf,
  lineWindow,
  lineWindows,
  parseCut,
  parseWordsFile,
  resolveCut,
  serializeWordsFile,
  toSourceClock,
  type CutFile,
  type LineWindow,
  type LineWordsEntry,
  type Timeline,
  type WordsFile,
} from './index.js';

const ROOT = '/media';

/**
 * A small cut with every kind of line: a TTS line cut off by `until`, an
 * on-camera line, and a yell that runs past its segment into the next one,
 * which plays the same take in step (as Night Wagon's TURBO... BOOST! does).
 */
function cut(overrides: Partial<CutFile> = {}): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'T', fps: 24, width: 640, height: 360 },
    media: { root: ROOT },
    segments: [
      { id: 'open', src: 'take:road', in: 0, out: 2 },
      { id: 'cam', src: 'take:rick', in: 3, out: 4.5 },
      { id: 'dash', src: 'take:dash', in: 1, out: 2, audio: { src: 'take:room', in: 0, volume: 0.7 } },
      { id: 'yell', src: 'take:yell', in: 1.75, out: 2.45 },
      { id: 'press', src: 'take:button', in: 0.85, out: 1.35, audio: { src: 'take:yell', in: 2.45 } },
    ],
    lines: [
      { id: 'tts', speaker: 'Buddy', text: 'The bridge is out.', src: 'tts/b2.wav', at: 'dash+0.05', until: 'dash.end', duration: 1.8 },
      { id: 'onCam', speaker: 'Rick', text: 'Then we jump it.', segment: 'cam' },
      { id: 'turbo', speaker: 'Rick', text: 'TURBO... BOOST!', segment: 'yell', until: 'press.end' },
    ],
    ...overrides,
  };
}

function timelineOf(c: CutFile): Timeline {
  const resolved = resolveCut(c);
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('\n'));
  return resolved.value;
}

function windowOf(c: CutFile, id: string): LineWindow {
  const timeline = timelineOf(c);
  const line = timeline.lines.find((l) => l.id === id);
  if (!line) throw new Error(`no ${id}`);
  const result = lineWindow(timeline, line, ROOT);
  if (!result.ok) throw new Error(result.reason);
  return result.window;
}

function entryFor(window: LineWindow, text: string, overrides: Partial<LineWordsEntry> = {}): LineWordsEntry {
  return {
    text,
    aligner: 'fake',
    fingerprint: fingerprintOf(window, 'abc'),
    loss: 0.5,
    words: [{ text: 'TURBO...', start: 2.11, end: 2.51, loss: 1 }, { text: 'BOOST!', start: 2.65, end: 2.91 }],
    ...overrides,
  };
}

describe("a line's audio window, in its source's own clock", () => {
  it('is a TTS file from 0 for the line, stopping where until cuts it off', () => {
    // dash runs 3.5–4.5; the line starts at 3.55, so until dash.end leaves 0.95 s of its 1.8 s file.
    expect(windowOf(cut(), 'tts')).toEqual({
      lineId: 'tts', kind: 'file', path: '/media/tts/b2.wav', source: 'tts/b2.wav', start: 0, end: 0.95, warnings: [],
    });
  });

  it('is the whole TTS file when nothing cuts it off', () => {
    const c = cut();
    c.lines = [{ id: 'tts', speaker: 'B', text: 'Hi.', src: 'tts/b2.wav', at: 'dash', duration: 1.8 }];
    expect(windowOf(c, 'tts')).toMatchObject({ start: 0, end: 1.8 });
  });

  it("is a line's own stretch of another take, from its in to its out", () => {
    // "Hello, Victoria." from 3.0–4.0 s of another take, laid 0.5 s into cam (which starts at 2).
    const c = cut();
    c.lines = [{ id: 'hello', speaker: 'Rex', text: 'Hello, Victoria.', src: 'take:doors', in: 3, out: 4, at: 'cam+0.5' }];
    expect(windowOf(c, 'hello')).toEqual({
      lineId: 'hello', kind: 'file', path: '/media/takes/doors.mp4', source: 'takes/doors.mp4', start: 3, end: 4, warnings: [],
    });
    // Cut off by until, it stops early in the take's clock too.
    c.lines = [{ ...c.lines[0], until: 'cam+1.1' }];
    expect(windowOf(c, 'hello')).toMatchObject({ start: 3, end: 3.6 });
    // Its words come back from the take's clock: aligned at 0.2 s into the window is 3.2 s in the take.
    expect(toSourceClock({ words: [{ text: 'Hello,', start: 0.2, end: 0.5 }] }, { start: 3 })).toEqual([{ text: 'Hello,', start: 3.2, end: 3.5 }]);
  });

  it("is a segment line's audio from its in-point for the line's length", () => {
    expect(windowOf(cut(), 'onCam')).toEqual({
      lineId: 'onCam', kind: 'segment', path: '/media/takes/rick.mp4', source: 'takes/rick.mp4', start: 3, end: 4.5, warnings: [],
    });
  });

  it("follows the segment's audio source and in-point, not its picture", () => {
    const c = cut();
    c.lines = [{ id: 'room', speaker: 'B', text: 'Hum.', segment: 'dash', at: 'dash+0.25' }];
    expect(windowOf(c, 'room')).toMatchObject({ source: 'takes/room.mp4', start: 0.25, end: 1 });
  });

  it('runs on past its segment with until, in the same take, when the next segment continues it in step', () => {
    // yell is 0.7 s and press 0.5 s; press plays the yell take from 2.45, right where yell left off.
    expect(windowOf(cut(), 'turbo')).toEqual({
      lineId: 'turbo', kind: 'segment', path: '/media/takes/yell.mp4', source: 'takes/yell.mp4', start: 1.75, end: 2.95, warnings: [],
    });
  });

  it('warns when the line runs on into sound that is not the same take in step', () => {
    const c = cut();
    c.segments[4] = { id: 'press', src: 'take:button', in: 0.85, out: 1.35, audio: { src: 'take:yell', in: 3.0 } };
    const window = windowOf(c, 'turbo');
    expect(window).toMatchObject({ start: 1.75, end: 2.95 });
    expect(window.warnings[0]).toContain('"press"');
  });

  it('has no window when its segment is silent', () => {
    const c = cut();
    c.segments[1] = { id: 'cam', src: 'take:rick', in: 3, out: 4.5, audio: false };
    const timeline = timelineOf(c);
    const result = lineWindows(timeline, ROOT).get('onCam');
    expect(result).toEqual({ ok: false, reason: 'its segment "cam" has no sound' });
  });
});

describe('aligned words', () => {
  it('shift back into the source clock by the window start', () => {
    const words = toSourceClock(
      { words: [{ text: 'TURBO...', start: 0.36, end: 0.76, loss: 1.0581 }, { text: 'BOOST!', start: 0.9, end: 1.16 }], loss: 1.03 },
      { start: 1.75 },
    );
    expect(words).toEqual([{ text: 'TURBO...', start: 2.11, end: 2.51, loss: 1.058 }, { text: 'BOOST!', start: 2.65, end: 2.91 }]);
  });

  it('drop blank and punctuation-only entries', () => {
    const words = toSourceClock(
      { words: [{ text: 'wagon.', start: 1.62, end: 2.06 }, { text: ' ', start: 2.06, end: 2.08 }, { text: '...', start: 2.08, end: 2.081 }, { text: 'And', start: 2.76, end: 2.84 }] },
      { start: 0 },
    );
    expect(words.map((w) => w.text)).toEqual(['wagon.', 'And']);
  });

  it('are counted against the words of the text, ignoring lone punctuation', () => {
    expect(countWords('TURBO... BOOST!')).toBe(2);
    expect(countWords("Rick. I'm a station wagon. ... And that button is for the flashers.")).toBe(12);
    expect(countWords("Rick, it's a forty-foot gap.")).toBe(5);
  });
});

describe('fingerprints and staleness', () => {
  const window = windowOf(cut(), 'turbo');
  const entry = entryFor(window, 'TURBO... BOOST!');

  it('keeps words whose text, source, window, file and aligner all match', () => {
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window, sha256: 'abc', aligner: 'fake' })).toEqual({ fresh: true });
  });

  it('calls words stale when the text changes', () => {
    expect(checkEntry(entry, { text: 'TURBO BOOST!', window })).toEqual({ fresh: false, reason: 'its text changed' });
  });

  it('calls words stale when the window moves', () => {
    const moved = { ...window, end: 2.8 };
    const check = checkEntry(entry, { text: 'TURBO... BOOST!', window: moved });
    expect(check.fresh).toBe(false);
  });

  it('calls words stale when the source or its contents change', () => {
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window: { ...window, source: 'takes/other.mp4' } }).fresh).toBe(false);
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window, sha256: 'def' })).toEqual({ fresh: false, reason: 'takes/yell.mp4 changed' });
  });

  it('calls words from another aligner stale only when an aligner is named', () => {
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window, sha256: 'abc', aligner: 'local' })).toEqual({ fresh: false, reason: 'it was aligned by fake' });
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window, sha256: 'abc' })).toEqual({ fresh: true });
  });

  it('calls words stale when their first word was snapped by another method, or not at all, only when a method is named', () => {
    const snapped = { ...entry, fingerprint: fingerprintOf(window, 'abc', 'speech-onset@1') };
    expect(checkEntry(snapped, { text: 'TURBO... BOOST!', window, snap: 'speech-onset@1' })).toEqual({ fresh: true });
    expect(checkEntry(snapped, { text: 'TURBO... BOOST!', window, snap: 'speech-onset@2' })).toEqual({ fresh: false, reason: 'its first word was snapped by speech-onset@1' });
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window, snap: 'speech-onset@1' })).toEqual({ fresh: false, reason: "its first word wasn't snapped to the speech onset" });
    expect(checkEntry(entry, { text: 'TURBO... BOOST!', window })).toEqual({ fresh: true });
  });
});

describe('applying a words file to a cut', () => {
  const window = windowOf(cut(), 'turbo');
  const file: WordsFile = { format: WORDS_FORMAT, lines: { turbo: entryFor(window, 'TURBO... BOOST!') } };

  it("puts fresh words on their line, in the source's clock, and the resolver maps them onto the timeline", () => {
    const merge = applyWords(cut(), file, { sha256: () => 'abc' });
    expect(merge.applied).toEqual(['turbo']);
    expect(merge.stale).toEqual([]);
    expect(merge.unchecked).toEqual([]);
    const line = merge.cut.lines?.find((l) => l.id === 'turbo');
    expect(line?.words).toEqual([{ text: 'TURBO...', start: 2.11, end: 2.51 }, { text: 'BOOST!', start: 2.65, end: 2.91 }]);
    // yell starts at 2 + 1.5 + 1 = 4.5 on the timeline, at source 1.75; BOOST! plays on into press.
    const resolved = timelineOf(merge.cut).lines.find((l) => l.id === 'turbo');
    expect(resolved?.words).toEqual([{ text: 'TURBO...', start: 4.86, end: 5.26 }, { text: 'BOOST!', start: 5.4, end: 5.66 }]);
  });

  it('never uses stale words: a changed line gets no words at all, even ones written inline', () => {
    const c = cut();
    c.lines![2] = { id: 'turbo', speaker: 'Rick', text: 'TURBO BOOST!', segment: 'yell', until: 'press.end', words: [{ text: 'old', start: 2, end: 2.5 }] };
    const merge = applyWords(c, file, { sha256: () => 'abc' });
    expect(merge.applied).toEqual([]);
    expect(merge.stale).toEqual([{ id: 'turbo', reason: 'its text changed' }]);
    expect(merge.cut.lines?.find((l) => l.id === 'turbo')?.words).toBeUndefined();
  });

  it('calls words stale when the audio file changed', () => {
    const merge = applyWords(cut(), file, { sha256: () => 'changed' });
    expect(merge.stale).toEqual([{ id: 'turbo', reason: 'takes/yell.mp4 changed' }]);
  });

  it('calls words stale when the window moved because the cut was re-edited', () => {
    const c = cut();
    const yell = c.segments[4];
    if (yell.still) throw new Error('expected a shot');
    c.segments[4] = { ...yell, out: 1.25 };
    const merge = applyWords(c, file, { sha256: () => 'abc' });
    expect(merge.stale.map((s) => s.id)).toEqual(['turbo']);
    expect(merge.stale[0].reason).toContain('window moved');
  });

  it("uses words it couldn't check against the file, and says so", () => {
    const merge = applyWords(cut(), file);
    expect(merge.applied).toEqual(['turbo']);
    expect(merge.unchecked).toEqual(['turbo']);
  });

  it('leaves lines without an entry as they are, and a media root override does not move the fingerprint', () => {
    const merge = applyWords(cut(), file, { root: '/elsewhere', sha256: () => 'abc' });
    expect(merge.applied).toEqual(['turbo']);
    expect(merge.cut.lines?.find((l) => l.id === 'tts')).toEqual(cut().lines![0]);
  });

  it('keeps resolveCut free of words files: the cut passed in is not changed', () => {
    const c = cut();
    applyWords(c, file);
    expect(c.lines?.[2].words).toBeUndefined();
  });
});

describe('the words file', () => {
  const window = windowOf(cut(), 'turbo');
  const file: WordsFile = {
    format: WORDS_FORMAT,
    lines: { turbo: entryFor(window, 'TURBO... BOOST!'), onCam: entryFor(windowOf(cut(), 'onCam'), 'Then we jump it.', { loss: null, words: [] }) },
  };

  it('writes the same bytes for the same content, lines in cut order, and reads back', () => {
    const text = serializeWordsFile(file, ['tts', 'onCam', 'turbo']);
    expect(serializeWordsFile({ format: WORDS_FORMAT, lines: { turbo: file.lines.turbo, onCam: file.lines.onCam } }, ['tts', 'onCam', 'turbo'])).toBe(text);
    expect(text.indexOf('"onCam"')).toBeLessThan(text.indexOf('"turbo"'));
    expect(text).toContain('        { "text": "TURBO...", "start": 2.11, "end": 2.51, "loss": 1 },\n');
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = parseWordsFile(JSON.parse(text));
    expect(parsed).toEqual({ ok: true, value: file });
  });

  it("keeps a line's snap record and snapping method, and reads them back", () => {
    const snapped: WordsFile = {
      format: WORDS_FORMAT,
      lines: {
        turbo: entryFor(window, 'TURBO... BOOST!', {
          fingerprint: fingerprintOf(window, 'abc', 'speech-onset@1'),
          snap: { aligned: 2.13, start: 2.11, onset: 2.11, floor: -41.2 },
        }),
        onCam: entryFor(windowOf(cut(), 'onCam'), 'Then we jump it.', { snap: { aligned: 3.1, start: 3.1, onset: null, floor: -120 } }),
      },
    };
    const text = serializeWordsFile(snapped, ['turbo', 'onCam']);
    expect(text).toContain('"sha256": "abc", "snap": "speech-onset@1" },\n      "loss": 0.5,\n      "snap": { "aligned": 2.13, "start": 2.11, "onset": 2.11, "floor": -41.2 },\n');
    expect(text).toContain('"snap": { "aligned": 3.1, "start": 3.1, "onset": null, "floor": -120 }');
    expect(parseWordsFile(JSON.parse(text))).toEqual({ ok: true, value: snapped });
    const bad = JSON.parse(text);
    bad.lines.turbo.snap = { aligned: 2.13 };
    expect(parseWordsFile(bad)).toEqual({ ok: false, message: 'lines.turbo.snap: expected { aligned, start, onset, floor }' });
  });

  it('rejects files of the wrong shape', () => {
    expect(parseWordsFile({ format: 'other', lines: {} }).ok).toBe(false);
    expect(parseWordsFile({ format: WORDS_FORMAT, lines: { a: { text: 'x' } } })).toEqual({ ok: false, message: 'lines.a.aligner: expected a string' });
  });
});

describe('the Night Wagon words files', () => {
  for (const name of ['night-wagon-take9', 'night-wagon-take10']) {
    it(`${name}: every line has fresh words, by text and window`, () => {
      const read = (file: string): unknown => JSON.parse(readFileSync(new URL(`../../docs/cuts/${file}`, import.meta.url), 'utf8'));
      const parsedCut = parseCut(read(`${name}.cut.json`));
      const parsedWords = parseWordsFile(read(`${name}.words.json`));
      if (!parsedCut.ok || !parsedWords.ok) throw new Error('unreadable');
      expect(parsedCut.value.lines?.some((l) => l.words !== undefined)).toBe(false);
      const merge = applyWords(parsedCut.value, parsedWords.value);
      expect(merge.stale).toEqual([]);
      expect(merge.applied).toEqual(parsedCut.value.lines?.map((l) => l.id) ?? []);
      expect(serializeWordsFile(parsedWords.value, merge.applied)).toBe(readFileSync(new URL(`../../docs/cuts/${name}.words.json`, import.meta.url), 'utf8'));
    });
  }
});
