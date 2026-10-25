import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ManifestError,
  approvedCut,
  currentCut,
  expandHome,
  findRepoRoot,
  parseProductionManifest,
  PRODUCTION_FORMAT,
} from '../../src/production/manifest';

const REPO = path.resolve(import.meta.dir, '../..');
const FILE = path.join(REPO, 'docs/productions/example.production.json');

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: PRODUCTION_FORMAT,
    slug: 'night-wagon-the-argument',
    title: 'Night Wagon: The Argument',
    series: { title: 'Night Wagon', slug: 'night-wagon' },
    media: { root: '~/media/crt' },
    cover: 'review/posters/ch-night-wagon-take9.jpg',
    approved: 'take9',
    cuts: [
      { id: 'take1', rendered: 'review/clips/ch-night-wagon.mp4', label: 'Take 1', notes: 'The first try.', createdAt: '2026-10-18T21:37:00.727Z' },
      { id: 'take9', cut: 'docs/cuts/night-wagon-take9.cut.json', label: 'Take 9', status: 'approved', createdAt: 1_790_000_000_000 },
      { cut: 'docs/cuts/night-wagon-take10.cut.json', label: 'Take 10', status: 'review' },
    ],
    ...overrides,
  };
}

const parse = (json: unknown, options = {}) => parseProductionManifest(json, FILE, { home: '/home/me', repo: REPO, ...options });

function problems(json: unknown): string {
  try {
    parse(json);
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError);
    return (error as Error).message;
  }
  throw new Error('expected the manifest to be refused');
}

describe('production manifests', () => {
  it('resolve cut paths against the repository and media paths against the media root', () => {
    const m = parse(manifest());
    expect(m.root).toBe('/home/me/media/crt');
    expect(m.cover).toBe('/home/me/media/crt/review/posters/ch-night-wagon-take9.jpg');
    expect(m.series).toEqual({ title: 'Night Wagon', slug: 'night-wagon' });
    expect(m.cuts[0]).toEqual({ id: 'take1', kind: 'rendered', rendered: '/home/me/media/crt/review/clips/ch-night-wagon.mp4', label: 'Take 1', status: 'none', notes: 'The first try.', createdAt: Date.parse('2026-10-18T21:37:00.727Z') });
    expect(m.cuts[1]).toMatchObject({ id: 'take9', kind: 'cut', cut: path.join(REPO, 'docs/cuts/night-wagon-take9.cut.json'), cutRef: 'docs/cuts/night-wagon-take9.cut.json', rendered: null, createdAt: 1_790_000_000_000 });
  });

  it("default a cut's id to its file's stem, and its status to none", () => {
    const m = parse(manifest());
    expect(m.cuts[2]).toMatchObject({ id: 'night-wagon-take10', status: 'review', notes: '', createdAt: null });
  });

  it('take a media root override and a series given as a title', () => {
    const m = parse(manifest({ series: 'Night Wagon' }), { root: '/srv/crt' });
    expect(m.root).toBe('/srv/crt');
    expect(m.series).toEqual({ title: 'Night Wagon' });
  });

  it('point at the approved and current cuts, by default the last approved and the last', () => {
    expect(approvedCut(parse(manifest()))).toBe('take9');
    expect(currentCut(parse(manifest()))).toBe('night-wagon-take10');
    const plain = parse(manifest({ approved: undefined, current: 'take1' }));
    expect(approvedCut(plain)).toBe('take9');
    expect(currentCut(plain)).toBe('take1');
    expect(approvedCut(parse(manifest({ approved: undefined, cuts: [manifest().cuts[0]] })))).toBeNull();
  });

  it('report every problem at once', () => {
    const message = problems({
      format: 'nope', slug: 'Bad Slug', title: '', media: {},
      cuts: [{ label: 'x' }, { id: 'a b', rendered: 'x.mp4', label: 'y', status: 'great' }, { cut: 'x.json', label: 'z' }],
    });
    for (const expected of ['format:', 'slug:', 'title:', 'media.root:', 'cuts[0]: needs "cut"', 'cuts[1].status', 'cuts[1].id', 'cuts[2].cut: expected a .cut.json']) {
      expect(message).toContain(expected);
    }
  });

  it('refuse a duplicate id, an unknown pointer, and an approved cut that is not approved', () => {
    expect(problems(manifest({ cuts: [manifest().cuts[0], manifest().cuts[0]] }))).toContain('"take1" is used twice');
    expect(problems(manifest({ current: 'take99' }))).toContain('current: expected the id of one of the cuts');
    expect(problems(manifest({ approved: 'take1' }))).toContain('the approved cut must be approved or final');
  });

  it('find the repository from inside it', () => {
    expect(findRepoRoot('/a/b/c', (p) => p === '/a/.git')).toBe('/a');
    expect(findRepoRoot('/x/y', () => false)).toBe('/x/y');
    expect(expandHome('~/m', '/h')).toBe('/h/m');
    expect(expandHome('/abs', '/h')).toBe('/abs');
  });
});

describe('the CRT TV production manifests', () => {
  const dir = path.join(REPO, 'docs/productions');
  const files = readdirSync(dir).filter((file) => file.endsWith('.production.json'));

  it('are all here, one per show on the review page', () => {
    expect(files.length).toBe(14);
  });

  for (const file of files) {
    it(`${file} parses, names its slug, and its cut files exist`, () => {
      const m = parseProductionManifest(JSON.parse(readFileSync(path.join(dir, file), 'utf8')), path.join(dir, file), { repo: REPO });
      expect(`${m.slug}.production.json`).toBe(file);
      for (const cut of m.cuts) if (cut.kind === 'cut') expect(existsSync(cut.cut)).toBe(true);
      // Cuts are in the order they were made.
      const dated = m.cuts.map((cut) => cut.createdAt).filter((t): t is number => t !== null);
      expect(dated).toEqual([...dated].sort((a, b) => a - b));
    });
  }

  it('give Night Wagon: The Argument Takes 1 to 8 as rendered cuts, then Take 9 approved and Take 10 under review', () => {
    const m = parseProductionManifest(JSON.parse(readFileSync(path.join(dir, 'night-wagon-the-argument.production.json'), 'utf8')), path.join(dir, 'x'), { repo: REPO });
    expect(m.cuts.map((cut) => `${cut.id}:${cut.kind}:${cut.status}`)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `take${n}:rendered:none`),
      'take9:cut:approved',
      'take10:cut:review',
    ]);
    expect(m.series?.title).toBe('Night Wagon');
  });
});
