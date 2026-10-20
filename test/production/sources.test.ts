import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyWords, parseCut, parseWordsFile, resolveCut, type CutFile, type Timeline, type WordsFile } from '../../src/cut/index';
import { cutMediaFiles, mediaTypeOf, mimeTypeOf, rewriteCutSources, rewriteWordsSources, UnmappedSourceError } from '../../src/production/sources';

const CUTS = path.resolve(import.meta.dir, '../../docs/cuts');
const ROOT = '/media/crt';

function load(name: string): { cut: CutFile; words: WordsFile } {
  const parsed = parseCut(JSON.parse(readFileSync(path.join(CUTS, `${name}.cut.json`), 'utf8')));
  const words = parseWordsFile(JSON.parse(readFileSync(path.join(CUTS, `${name}.words.json`), 'utf8')));
  if (!parsed.ok || !words.ok) throw new Error(`${name} does not parse`);
  return { cut: parsed.value, words: words.value };
}

function resolved(cut: CutFile, root?: string): Timeline {
  const result = resolveCut(cut, root ? { root } : {});
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

/** A stand-in asset id for each file, as the studio would give. */
const assetFor = (file: string) => `pm${Buffer.from(file).toString('hex').slice(-24)}`;

describe('the media a cut uses', () => {
  const { cut } = load('night-wagon-take9');
  const files = cutMediaFiles(resolved(cut, ROOT));

  it('lists every take and file once, with where it is first used', () => {
    expect(new Set(files.map((f) => f.ref)).size).toBe(files.length);
    expect(files.find((f) => f.ref === 'take:nw6-button-t1')).toEqual({ ref: 'take:nw6-button-t1', path: `${ROOT}/takes/nw6-button-t1.mp4`, role: 'segment' });
    expect(files.find((f) => f.ref === 'take:nw7-dash-t1')?.role).toBe('segment-audio');
    expect(files.find((f) => f.ref === 'audio/tts/b2.wav')?.role).toBe('line');
    expect(files.some((f) => f.ref.startsWith('color:'))).toBe(false);
  });

  it('types each file by its extension, and its sound by where it plays', () => {
    expect(mediaTypeOf('a/take.mp4', 'line')).toBe('video');
    expect(mediaTypeOf('a/still.png', 'segment')).toBe('image');
    expect(mediaTypeOf('a/b2.wav', 'line')).toBe('voice');
    expect(mediaTypeOf('a/theme.mp3', 'music')).toBe('music');
    expect(mediaTypeOf('a/glass.wav', 'sfx')).toBe('sfx');
    expect(mimeTypeOf('x.MP4')).toBe('video/mp4');
    expect(mimeTypeOf('x.wav')).toBe('audio/wav');
    expect(mimeTypeOf('x.txt')).toBeNull();
  });
});

describe('the media of a cut with beds, labelled sound and provenance', () => {
  it('lists every part of a bed once, adds nothing for sound heard in a take, and brings the first-frame stills along', () => {
    const football = cutMediaFiles(resolved(load('football-take1').cut, ROOT));
    expect(football.filter((f) => f.ref === 'audio/fb-crowd.mp3')).toEqual([{ ref: 'audio/fb-crowd.mp3', path: `${ROOT}/audio/fb-crowd.mp3`, role: 'sfx' }]);
    const palm = cutMediaFiles(resolved(load('palm-court-take2').cut, ROOT));
    expect(palm.map((f) => f.role)).toEqual(['segment', 'overlay']);
    const rigg = cutMediaFiles(resolved(load('rigg-take5').cut, ROOT));
    expect(rigg.filter((f) => f.role === 'provenance').map((f) => f.ref)).toEqual(['rigg5/wide.png', 'rigg5/shove-end.png', 'rigg5/her.png', 'rigg5/turn-end.png', 'rigg5/mcu.png']);
    expect(mediaTypeOf('rigg5/wide.png', 'provenance')).toBe('image');
  });

  it('rewrites provenance by the same assets, keeping takes that were not uploaded as their names', () => {
    const { cut } = load('rigg-take5');
    const byRef = new Map(cutMediaFiles(resolved(cut, ROOT)).map((f) => [f.ref, assetFor(f.path)]));
    const rewritten = rewriteCutSources(cut, byRef);
    const climax = `asset:${byRef.get('take:rigg5-climax-t1')}`;
    expect(rewritten.sources?.[climax]).toEqual({ step: 'extend', extendedFrom: 'take:rigg5-lines-t2', storyboard: 'rigg5-climax' });
    expect(rewritten.sources?.['take:rigg5-lines-t2']).toEqual({ step: 'generate', storyboard: 'rigg5-lines', firstFrame: `asset:${byRef.get('rigg5/mcu.png')}` });
    expect(parseCut(JSON.parse(JSON.stringify(rewritten))).ok).toBe(true);
  });
});

describe('rewriting a cut to asset refs', () => {
  for (const name of ['night-wagon-take9', 'breeze-take4', 'football-take1', 'bellamy-ranch-take6']) {
    it(`${name}: every source becomes asset:, and the timeline is unchanged`, () => {
      const { cut } = load(name);
      const original = resolved(cut, ROOT);
      const byRef = new Map(cutMediaFiles(original).map((f) => [f.ref, assetFor(f.path)]));
      const rewritten = rewriteCutSources(cut, byRef);
      const refs = JSON.stringify(rewritten).match(/"src":"[^"]*"/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toMatch(/"src":"(asset:pm[0-9a-f]+|color:[^"]+)"/);
      expect(rewritten.output).toBeUndefined();
      expect(rewritten.media).toEqual({ root: '.' });
      // The rewritten cut is a valid cut file on its own.
      expect(parseCut(JSON.parse(JSON.stringify(rewritten))).ok).toBe(true);
      const after = resolved(rewritten);
      expect(after.segments.map((s) => [s.id, s.start, s.end])).toEqual(original.segments.map((s) => [s.id, s.start, s.end]));
      expect(after.length).toBe(original.length);
      // The cut it was made from is left as it was.
      expect(cut.output).toBeDefined();
    });
  }

  it('refuses a source with no uploaded asset, naming it', () => {
    const { cut } = load('night-wagon-take9');
    expect(() => rewriteCutSources(cut, new Map())).toThrow(UnmappedSourceError);
  });

  it('keeps word timings applying, matched to the same assets by hash', () => {
    const { cut, words } = load('night-wagon-take9');
    const original = resolved(cut, ROOT);
    const files = cutMediaFiles(original);
    const byRef = new Map(files.map((f) => [f.ref, assetFor(f.path)]));
    const byPath = new Map(files.map((f) => [f.path, assetFor(f.path)]));
    // Each asset's content hash is what the words file recorded for its file.
    const shaOf = new Map(Object.values(words.lines).map((entry) => [`asset:${assetFor(path.join(ROOT, entry.fingerprint.source))}`, entry.fingerprint.sha256]));
    const before = applyWords(cut, words, { root: ROOT, sha256: (file) => words.lines && Object.values(words.lines).find((e) => path.join(ROOT, e.fingerprint.source) === file)?.fingerprint.sha256 });
    const rewrittenWords = rewriteWordsSources(words, ROOT, byPath);
    for (const entry of Object.values(rewrittenWords.lines)) expect(entry.fingerprint.source).toMatch(/^asset:pm/);
    const after = applyWords(rewriteCutSources(cut, byRef), rewrittenWords, { sha256: (ref) => shaOf.get(ref) });
    expect(before.applied.length).toBeGreaterThan(0);
    expect(after.applied).toEqual(before.applied);
    expect(after.stale).toEqual(before.stale);
    expect(after.unchecked).toEqual([]);
    const lineWords = (c: CutFile) => resolved(c).lines.map((l) => [l.id, l.words]);
    expect(lineWords(after.cut)).toEqual(resolved(before.cut, ROOT).lines.map((l) => [l.id, l.words]));
  });
});
