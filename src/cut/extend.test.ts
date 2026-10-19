import { describe, expect, it } from 'bun:test';
import { CUT_FORMAT, extendCut, loadCutSource, parseCut, parseCutExtension, resolveCut, type CutExtension, type CutFile } from './index.js';

function base(): CutFile {
  return {
    format: CUT_FORMAT,
    meta: { title: 'Bellamy Ranch', version: 'Take 6', fps: 24, width: 1280, height: 720, length: 4 },
    media: { root: '/media' },
    output: 'takes/her.mp4',
    segments: [
      { id: 'a', src: 'take:a', in: 0, out: 1 },
      { id: 'smirk', src: 'take:rex', in: 3.32, out: 3.75 },
      { id: 'freeze', src: 'take:stun', in: 0.2, out: 2, end: 'sting.end' },
    ],
    lines: [{ id: 'l', speaker: 'Rex', text: 'Hi.', segment: 'a' }],
    music: [{ id: 'sting', src: 'take:organ', in: 0, out: 3, at: 'a.end' }],
  };
}

function extension(patch: Partial<CutExtension> = {}): CutExtension {
  return { format: CUT_FORMAT, extends: 'bellamy', ...patch };
}

function merged(patch: Partial<CutExtension>): CutFile {
  const result = extendCut(base(), extension(patch));
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.value;
}

describe('extendCut', () => {
  it('replaces items by id where they stand, removes by id, and merges meta field by field', () => {
    const cut = merged({
      meta: { version: 'Take 6 (freeze on Rex)' },
      output: 'takes/rex.mp4',
      remove: ['smirk'],
      segments: [{ id: 'freeze', src: 'take:rex', in: 3.32, out: 4.2, end: 'sting.end' }],
    });
    expect(cut.segments.map((s) => [s.id, s.src])).toEqual([['a', 'take:a'], ['freeze', 'take:rex']]);
    expect(cut.meta).toEqual({ title: 'Bellamy Ranch', version: 'Take 6 (freeze on Rex)', fps: 24, width: 1280, height: 720, length: 4 });
    expect(cut.output).toBe('takes/rex.mp4');
    expect(cut.lines).toEqual(base().lines);
    expect(cut.music).toEqual(base().music);
    // It resolves like any cut: the freeze still ends with the sting.
    const timeline = resolveCut(cut);
    if (!timeline.ok) throw new Error(timeline.errors.map((e) => e.message).join('\n'));
    expect(timeline.value.segments.map((s) => [s.id, s.start, s.end])).toEqual([['a', 0, 1], ['freeze', 1, 4]]);
  });

  it('adds new items at the end, or a segment after a named one or first', () => {
    const cut = merged({
      segments: [
        { id: 'tag', src: 'take:t', in: 0, out: 1 },
        { id: 'insert', src: 'take:i', in: 0, out: 0.5, after: 'a' },
        { id: 'cold', src: 'take:c', in: 0, out: 0.5, after: '@start' },
        { id: 'smirk', src: 'take:rex', in: 3.32, out: 3.6, after: 'freeze' },
      ],
      sfx: [{ id: 'thud', src: 'thud.wav', at: 'a', duration: 0.2 }],
    });
    expect(cut.segments.map((s) => s.id)).toEqual(['cold', 'a', 'insert', 'freeze', 'smirk', 'tag']);
    expect(cut.segments.find((s) => s.id === 'smirk')?.out).toBe(3.6);
    expect(cut.segments.every((s) => !('after' in s))).toBe(true);
    expect(cut.sfx?.map((s) => s.id)).toEqual(['thud']);
  });

  it('reports removing what the base lacks, removing and giving the same id, and an unknown after', () => {
    const errors = (patch: Partial<CutExtension>): string[] => {
      const result = extendCut(base(), extension(patch));
      return result.ok ? [] : result.errors.map((e) => `${e.code} ${e.id ?? ''} ${e.field ?? ''}`.trim());
    };
    expect(errors({ remove: ['nope'] })).toEqual(['unknown-item nope remove']);
    expect(errors({ remove: ['freeze'], segments: [{ id: 'freeze', src: 'take:x', in: 0, out: 1 }] })).toEqual(['conflicting-fields freeze remove']);
    expect(errors({ segments: [{ id: 'x', src: 'take:x', in: 0, out: 1, after: 'nope' }] })).toEqual(['unknown-item x after']);
  });
});

describe('parseCutExtension', () => {
  it('needs only format and extends, and checks the items it gives', () => {
    expect(parseCutExtension({ format: CUT_FORMAT, extends: 'bellamy-ranch-take6' })).toEqual({
      ok: true,
      value: { format: CUT_FORMAT, extends: 'bellamy-ranch-take6' },
    });
    const bad = parseCutExtension({ format: CUT_FORMAT, extends: '../other', remove: [1], segments: [{ id: 'x', after: 'a' }] });
    expect(bad.ok ? [] : bad.errors.map((e) => e.field)).toEqual(['extends', 'remove', 'segments[0].src', 'segments[0].in', 'segments[0].out']);
  });

  it("is what parseCut points to when a file extends another", () => {
    const result = parseCut({ format: CUT_FORMAT, extends: 'bellamy-ranch-take6' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].message).toContain('loadCutSource');
  });
});

describe('loadCutSource', () => {
  const files: Record<string, unknown> = {
    bellamy: base(),
    rex: { format: CUT_FORMAT, extends: 'bellamy', remove: ['smirk'], output: 'takes/rex.mp4' },
    rexlong: { format: CUT_FORMAT, extends: 'rex', meta: { version: 'long' } },
    loopa: { format: CUT_FORMAT, extends: 'loopb' },
    loopb: { format: CUT_FORMAT, extends: 'loopa' },
    broken: { format: CUT_FORMAT, extends: 'bellamy', segments: [{ id: 'q' }] },
  };
  const read = async (name: string): Promise<unknown> => {
    if (!(name in files)) throw new Error(`no ${name}.cut.json`);
    return files[name];
  };

  it('returns a plain cut as parseCut does', async () => {
    expect(await loadCutSource(base(), read)).toEqual(parseCut(base()));
  });

  it('follows a chain of bases', async () => {
    const result = await loadCutSource(files.rexlong, read, { name: 'rexlong' });
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
    expect(result.value.segments.map((s) => s.id)).toEqual(['a', 'freeze']);
    expect([result.value.output, result.value.meta.version]).toEqual(['takes/rex.mp4', 'long']);
  });

  it('reports a loop, a missing base and a broken extension', async () => {
    const loop = await loadCutSource(files.loopa, read, { name: 'loopa' });
    expect(loop.ok ? [] : loop.errors.map((e) => [e.code, e.message])).toEqual([['extends-cycle', 'Cuts extend each other in a loop: loopa → loopb → loopa']]);
    const missing = await loadCutSource({ format: CUT_FORMAT, extends: 'gone' }, read);
    expect(missing.ok ? [] : missing.errors.map((e) => e.message)).toEqual(['extends: can\'t read the base cut "gone": no gone.cut.json']);
    const broken = await loadCutSource(files.broken, read);
    expect(broken.ok ? [] : broken.errors.map((e) => e.field)).toEqual(['segments[0].src', 'segments[0].in', 'segments[0].out']);
  });
});
