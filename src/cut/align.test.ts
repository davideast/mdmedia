import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alignCutWords, loadCutWithWords, wordsFilePath } from './align.js';
import {
  AlignerUnavailableError,
  CUT_FORMAT,
  SNAP_METHOD,
  type Aligner,
  type AlignerAudio,
  type Alignment,
  type CutFile,
  type LineWindow,
  type OnsetMeasurement,
} from './index.js';

/** An aligner that times each word of the text evenly from 0.1 s, and records what it was asked. */
class FakeAligner implements Aligner {
  readonly calls: Array<{ bytes: string; text: string }> = [];
  constructor(readonly name = 'fake', private readonly loss = 0.6, private readonly fail?: (text: string) => Error | undefined) {}

  async align(audio: AlignerAudio, text: string): Promise<Alignment> {
    this.calls.push({ bytes: new TextDecoder().decode(audio.bytes), text });
    const error = this.fail?.(text);
    if (error) throw error;
    const tokens = text.split(/\s+/);
    return {
      words: tokens.flatMap((t, i) => [{ text: t, start: 0.1 + i * 0.2, end: 0.25 + i * 0.2, loss: 0.5 }, { text: ' ', start: 0.25 + i * 0.2, end: 0.3 + i * 0.2 }]),
      loss: this.loss,
    };
  }
}

let dir = '';
let cutPath = '';
const extract = async (w: LineWindow): Promise<AlignerAudio> => ({ bytes: new TextEncoder().encode(`${w.source}@${w.start}-${w.end}`), sampleRate: 16000 });
const hash = async (file: string): Promise<string> => `hash:${path.basename(file)}`;
/** The fake audio isn't a WAV, so its onset is "measured" here: none found, so first words stay as aligned. */
const measureOnset = (): OnsetMeasurement => ({ onset: null, floor: -90, threshold: -50, peak: -20 });

function cut(lines: CutFile['lines']): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'T', fps: 24, width: 640, height: 360 },
    media: { root: 'media' },
    segments: [
      { id: 'cam', src: 'take:rick', in: 3, out: 4.5 },
      { id: 'dash', src: 'take:dash', in: 1, out: 3, audio: { src: 'take:room', in: 0 } },
    ],
    lines,
  };
}

const twoLines: CutFile['lines'] = [
  { id: 'jump', speaker: 'Rick', text: 'Then we jump it.', segment: 'cam' },
  { id: 'gap', speaker: 'Buddy', text: "It's a gap.", src: 'tts/b4.wav', at: 'dash+0.05', duration: 1.2 },
];

async function writeCut(c: CutFile): Promise<void> {
  await writeFile(cutPath, JSON.stringify(c, null, 2));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cut-align-test-'));
  cutPath = path.join(dir, 'scene.cut.json');
  await writeCut(cut(twoLines));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mdmedia cut words', () => {
  it('names the words file after the cut', () => {
    expect(wordsFilePath('/x/night-wagon-take9.cut.json')).toBe('/x/night-wagon-take9.words.json');
  });

  it('aligns each line in its own window, shifts the words into source time, and writes the words file', async () => {
    const aligner = new FakeAligner();
    const result = await alignCutWords({ cutPath, aligner, extract, hash, measureOnset });
    expect(aligner.calls).toEqual([
      { bytes: 'takes/rick.mp4@3-4.5', text: 'Then we jump it.' },
      { bytes: 'tts/b4.wav@0-1.2', text: "It's a gap." },
    ]);
    expect(result.lines.map((l) => [l.id, l.status, l.loss, l.words])).toEqual([['jump', 'aligned', 0.6, 4], ['gap', 'aligned', 0.6, 3]]);
    // jump's first word is 0.1 s into its window, which starts at source 3.0; cam starts the timeline at 0.
    expect(result.lines[0].speech).toEqual({ start: 0.1, end: 0.85 });
    // gap starts at dash (1.5) + 0.05 on the timeline; its third word ends 0.65 s in.
    expect(result.lines[1].speech).toEqual({ start: 1.65, end: 2.2 });

    const written = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    expect(written.lines.jump.fingerprint).toEqual({ source: 'takes/rick.mp4', start: 3, end: 4.5, sha256: 'hash:rick.mp4', snap: SNAP_METHOD });
    expect(written.lines.jump.snap).toEqual({ aligned: 3.1, start: 3.1, onset: null, floor: -90 });
    expect(written.lines.jump.words[0]).toEqual({ text: 'Then', start: 3.1, end: 3.25, loss: 0.5 });
    expect(written.lines.jump.aligner).toBe('fake');

    const loaded = await loadCutWithWords(cutPath);
    // The real hash of a missing file can't be taken, so the words are used unchecked.
    expect(loaded.merge.applied).toEqual(['jump', 'gap']);
    expect(loaded.timeline.lines[0].words[0]).toEqual({ text: 'Then', start: 0.1, end: 0.25 });
  });

  it('realigns only lines whose text, window, file or aligner changed, and --force realigns all', async () => {
    await alignCutWords({ cutPath, aligner: new FakeAligner(), extract, hash, measureOnset });
    const before = await readFile(wordsFilePath(cutPath), 'utf8');

    const again = new FakeAligner();
    const unchanged = await alignCutWords({ cutPath, aligner: again, extract, hash, measureOnset });
    expect(again.calls).toEqual([]);
    expect(unchanged.lines.map((l) => l.status)).toEqual(['fresh', 'fresh']);
    expect(unchanged.written).toBe(false);
    expect(await readFile(wordsFilePath(cutPath), 'utf8')).toBe(before);

    await writeCut(cut([twoLines[0], { ...twoLines[1], text: "It's a forty-foot gap." }]));
    const edited = new FakeAligner();
    const afterEdit = await alignCutWords({ cutPath, aligner: edited, extract, hash, measureOnset });
    expect(edited.calls.map((c) => c.text)).toEqual(["It's a forty-foot gap."]);
    expect(afterEdit.lines.map((l) => l.status)).toEqual(['fresh', 'aligned']);

    const changedFile = new FakeAligner();
    await alignCutWords({ cutPath, aligner: changedFile, extract, measureOnset, hash: async (f) => (f.endsWith('rick.mp4') ? 'new' : hash(f)) });
    expect(changedFile.calls.map((c) => c.text)).toEqual(['Then we jump it.']);

    const other = new FakeAligner('other');
    await alignCutWords({ cutPath, aligner: other, extract, hash, measureOnset });
    expect(other.calls).toHaveLength(2);

    const forced = new FakeAligner('other');
    const result = await alignCutWords({ cutPath, aligner: forced, extract, hash, measureOnset, force: true });
    expect(forced.calls).toHaveLength(2);
    expect(result.lines.map((l) => l.status)).toEqual(['aligned', 'aligned']);
  });

  it('warns, without failing, about a high loss or a word count that differs from the text', async () => {
    const aligner: Aligner = {
      name: 'fake',
      align: async () => ({ words: [{ text: 'TURBO', start: 0.1, end: 0.4 }], loss: 1.03 }),
    };
    await writeCut(cut([{ id: 'turbo', speaker: 'Rick', text: 'TURBO... BOOST!', segment: 'cam' }]));
    const result = await alignCutWords({ cutPath, aligner, extract, hash, measureOnset });
    expect(result.lines[0].status).toBe('aligned');
    expect(result.lines[0].warnings).toEqual([
      'its loss is high (1.03); check it by ear',
      'it came back with 1 words, but its text has 2',
    ]);
  });

  it('marks a line it could not align as stale and carries on with the rest', async () => {
    const aligner = new FakeAligner('fake', 0.6, (text) => (text.startsWith('Then') ? new Error('HTTP 400') : undefined));
    const result = await alignCutWords({ cutPath, aligner, extract, hash, measureOnset });
    expect(result.lines.map((l) => [l.id, l.status, l.reason])).toEqual([['jump', 'stale', 'HTTP 400'], ['gap', 'aligned', undefined]]);
    const written = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    expect(Object.keys(written.lines)).toEqual(['gap']);
  });

  it('stops when the aligner can align nothing, keeping the lines already aligned', async () => {
    const aligner = new FakeAligner('fake', 0.6, (text) => (text.startsWith('It') ? new AlignerUnavailableError('no permission') : undefined));
    await expect(alignCutWords({ cutPath, aligner, extract, hash, measureOnset })).rejects.toThrow('no permission');
    const written = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    expect(Object.keys(written.lines)).toEqual(['jump']);
  });

  it("snaps each line's first word back to the speech onset measured in its own audio, and records it", async () => {
    // jump's speech starts 0.04 s before the aligner's first word; gap's starts 0.03 s after it, and a start never moves later.
    const early: Record<string, number> = { 'takes/rick.mp4': 0.04, 'tts/b4.wav': -0.03 };
    const measure = (audio: AlignerAudio): OnsetMeasurement => {
      const source = new TextDecoder().decode(audio.bytes).split('@')[0];
      return { onset: Math.round((0.1 - early[source]) * 1e6) / 1e6, floor: -71.26, threshold: -50, peak: -20 };
    };
    const result = await alignCutWords({ cutPath, aligner: new FakeAligner(), extract, hash, measureOnset: measure });
    const written = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    expect(written.lines.jump.snap).toEqual({ aligned: 3.1, start: 3.06, onset: 3.06, floor: -71.3 });
    expect(written.lines.jump.words.slice(0, 2)).toEqual([{ text: 'Then', start: 3.06, end: 3.25, loss: 0.5 }, { text: 'we', start: 3.3, end: 3.45, loss: 0.5 }]);
    expect(written.lines.gap.snap).toEqual({ aligned: 0.1, start: 0.1, onset: 0.13, floor: -71.3 });
    expect(written.lines.gap.words[0].start).toBe(0.1);
    expect(result.lines[0].speech).toEqual({ start: 0.06, end: 0.85 });
    expect(result.lines[0].snap?.start).toBe(3.06);
  });

  it('realigns, once, a line whose first word was snapped by another method or not at all', async () => {
    await alignCutWords({ cutPath, aligner: new FakeAligner(), extract, hash, measureOnset });
    const stored = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    delete stored.lines.jump.fingerprint.snap;
    stored.lines.gap.fingerprint.snap = 'speech-onset@0';
    await writeFile(wordsFilePath(cutPath), JSON.stringify(stored));
    const again = new FakeAligner();
    await alignCutWords({ cutPath, aligner: again, extract, hash, measureOnset });
    expect(again.calls.map((c) => c.text)).toEqual(['Then we jump it.', "It's a gap."]);
    const once = new FakeAligner();
    await alignCutWords({ cutPath, aligner: once, extract, hash, measureOnset });
    expect(once.calls).toEqual([]);
  });

  it("keeps the aligner's first word, and says so, when the audio can't be measured", async () => {
    const result = await alignCutWords({ cutPath, aligner: new FakeAligner(), extract, hash });
    expect(result.lines[0].status).toBe('aligned');
    expect(result.lines[0].warnings).toEqual(["couldn't measure where its speech starts, so its first word is as aligned (not a WAV file)"]);
    const written = JSON.parse(await readFile(wordsFilePath(cutPath), 'utf8'));
    expect(written.lines.jump.fingerprint.snap).toBeUndefined();
    expect(written.lines.jump.snap).toBeUndefined();
    expect(written.lines.jump.words[0].start).toBe(3.1);
  });

  it('honours a media root override without changing the recorded source', async () => {
    const aligner = new FakeAligner();
    const result = await alignCutWords({ cutPath, aligner, extract, hash, measureOnset, root: '/moved' });
    expect(result.lines[0].window?.path).toBe('/moved/takes/rick.mp4');
    expect(result.lines[0].window?.source).toBe('takes/rick.mp4');
  });
});
