import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProductionAsset, ProductionCutBody, ProductionMediaUpload, ProductionPatch, ProductionSummary, ProductionUpsert } from '../../src/remote/client';
import { parseProductionManifest, PRODUCTION_FORMAT, type ProductionManifest } from '../../src/production/manifest';
import { describePush, describeTotals, pushProduction, type ProductionPushClient } from '../../src/production/push';
import type { ThumbMaker } from '../../src/production/thumbs';

/** An in-memory studio: media by hash, productions by slug, cuts replaced whole. */
class FakeStudio implements ProductionPushClient {
  media = new Map<string, ProductionAsset>();
  uploads: ProductionMediaUpload[] = [];
  productions = new Map<string, ProductionSummary & { cutBodies: Map<string, ProductionCutBody> }>();
  deleted: string[] = [];
  patches: ProductionPatch[] = [];

  async findProductionMedia(hashes: readonly string[]) {
    return new Map(hashes.filter((h) => this.media.has(h)).map((h) => [h, this.media.get(h)!]));
  }

  async uploadProductionMedia(upload: ProductionMediaUpload) {
    const bytes = Buffer.from(await upload.body.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(upload.sha256);
    expect(bytes.length).toBe(upload.byteLength);
    this.uploads.push(upload);
    const asset: ProductionAsset = { id: `pm${upload.sha256.slice(0, 12)}`, mediaType: upload.mediaType, mimeType: upload.mimeType, byteLength: upload.byteLength, sha256: upload.sha256, width: 0, height: 0, links: { content: '', thumbnail: null } };
    this.media.set(upload.sha256, asset);
    return asset;
  }

  async upsertProduction(body: ProductionUpsert) {
    const existing = this.productions.get(body.slug);
    const production = existing ?? { id: `pr-${body.slug}`, slug: body.slug, title: body.title, series: null, coverAssetId: null, currentCutId: null, approvedCutId: null, cutCount: 0, cuts: [], createdAt: 1, updatedAt: 1, links: { self: '', cover: null, coverThumbnail: null }, cutBodies: new Map() };
    production.title = body.title;
    production.coverAssetId = body.coverAssetId ?? null;
    production.series = body.series ? { id: `se-${body.series.slug ?? 'x'}`, title: body.series.title } : null;
    this.productions.set(body.slug, production);
    // The answer describes the cuts the studio had before this push.
    return { ...production, cuts: [...production.cuts] };
  }

  private byId(id: string) {
    return [...this.productions.values()].find((p) => p.id === id)!;
  }

  async putProductionCut(id: string, cutId: string, body: ProductionCutBody) {
    const production = this.byId(id);
    production.cutBodies.set(cutId, body);
    production.cuts = [...production.cuts.filter((c) => c.id !== cutId), { id: cutId, label: body.label, status: body.status, kind: body.kind, lengthSeconds: null, createdAt: body.createdAt ?? 0, order: body.order, renderedAssetId: body.renderedAssetId ?? null, links: { self: '', rendered: null } }];
    return {};
  }

  async deleteProductionCut(id: string, cutId: string) {
    const production = this.byId(id);
    production.cuts = production.cuts.filter((c) => c.id !== cutId);
    production.cutBodies.delete(cutId);
    this.deleted.push(cutId);
  }

  async updateProduction(id: string, patch: ProductionPatch) {
    this.patches.push(patch);
    const production = this.byId(id);
    Object.assign(production, patch);
    return production;
  }
}

let dir: string;
let repo: string;
let root: string;
const write = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Thumbnails as files named by their segment's source and in-point, so shots of one frame share one. */
const thumbs: ThumbMaker = async (_timeline, segment) => {
  if (segment.src.kind !== 'take' && segment.src.kind !== 'file') return null;
  const file = path.join(dir, 'thumbs', `${path.basename(segment.src.path)}-${segment.in}.jpg`);
  write(file, `thumb of ${segment.src.path} at ${segment.in}`);
  return file;
};

const options = { thumbs, duration: async () => undefined };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-push-'));
  repo = path.join(dir, 'repo');
  root = path.join(dir, 'media');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  for (const take of ['road', 'dash', 'yell']) write(path.join(root, 'takes', `${take}.mp4`), `movie ${take}`);
  write(path.join(root, 'audio/line.wav'), 'a line');
  write(path.join(root, 'takes/ep-take9.mp4'), 'rendered take 9');
  write(path.join(root, 'takes/ep-take10.mp4'), 'rendered take 10');
  write(path.join(root, 'review/clips/ch-ep.mp4'), 'rendered take 1');
  // The review page's copy of Take 9 is the same bytes as the take.
  write(path.join(root, 'review/clips/ch-ep-take9.mp4'), 'rendered take 9');
  write(path.join(root, 'review/posters/ch-ep-take9.jpg'), 'poster');
  write(path.join(repo, 'docs/cuts/ep-take9.cut.json'), JSON.stringify({
    format: 'mdmedia.cut@1',
    meta: { title: 'Ep', fps: 24, width: 640, height: 480 },
    media: { root: '/nowhere' },
    output: 'takes/ep-take9.mp4',
    segments: [
      { id: 'open', src: 'take:road', in: 0, out: 2 },
      { id: 'dash', src: 'take:dash', in: 1, out: 2, audio: { src: 'take:road', in: 0 } },
      { id: 'black', src: 'color:black', in: 0, out: 0.5 },
    ],
    lines: [{ id: 'hello', speaker: 'Buddy', text: 'Hello there.', src: 'audio/line.wav', at: 0.5, duration: 1 }],
  }));
  write(path.join(repo, 'docs/cuts/ep-take9.words.json'), JSON.stringify({
    format: 'mdmedia.cut-words@1',
    lines: { hello: { text: 'Hello there.', aligner: 'test', loss: null, fingerprint: { source: 'audio/line.wav', start: 0, end: 1, sha256: sha(path.join(root, 'audio/line.wav')) }, words: [{ text: 'Hello', start: 0.1, end: 0.4 }] } },
  }));
  // Take 10 extends Take 9: one shot swapped, its own output.
  write(path.join(repo, 'docs/cuts/ep-take10.cut.json'), JSON.stringify({
    format: 'mdmedia.cut@1', extends: 'ep-take9', output: 'takes/ep-take10.mp4',
    segments: [{ id: 'dash', src: 'take:yell', in: 0, out: 1 }],
  }));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function manifest(overrides: Record<string, unknown> = {}): ProductionManifest {
  const json = {
    format: PRODUCTION_FORMAT, slug: 'ep', title: 'Episode', series: { title: 'Night Wagon', slug: 'night-wagon' },
    media: { root }, cover: 'review/posters/ch-ep-take9.jpg', approved: 'take9',
    cuts: [
      { id: 'take1', rendered: 'review/clips/ch-ep.mp4', label: 'Take 1', notes: 'First.', createdAt: '2026-10-18T21:37:00.727Z' },
      { id: 'take9', cut: 'docs/cuts/ep-take9.cut.json', label: 'Take 9', status: 'approved', notes: 'Opens on the road.', createdAt: '2026-10-19T06:55:51.502Z' },
      // The review page's copy of Take 9: other path, same bytes.
      { id: 'take9-review', rendered: 'review/clips/ch-ep-take9.mp4', label: 'Take 9 (review copy)' },
      { id: 'take10', cut: 'docs/cuts/ep-take10.cut.json', label: 'Take 10', status: 'review' },
    ],
    ...overrides,
  };
  return parseProductionManifest(json, path.join(repo, 'docs/productions/ep.production.json'));
}

describe('production push', () => {
  const studio = new FakeStudio();

  it('uploads each file once, and sends cuts that name only assets', async () => {
    const report = await pushProduction(studio, manifest(), options);
    // road, dash, yell, line, 2 rendered takes, Take 1, cover, and 3 distinct thumbnails (both cuts open on the same frame).
    // Take 9's review copy is the same bytes as its take, so it isn't sent again.
    const thumbsMade = fs.readdirSync(path.join(dir, 'thumbs')).length;
    expect(thumbsMade).toBe(3);
    expect(report.uploaded.length).toBe(8 + thumbsMade);
    expect(report.reused).toEqual([]);
    expect(studio.uploads.length).toBe(report.uploaded.length);
    expect(new Set(studio.uploads.map((u) => u.sha256)).size).toBe(studio.uploads.length);
    expect(studio.uploads.find((u) => u.mimeType === 'audio/wav')?.mediaType).toBe('voice');

    const production = studio.productions.get('ep')!;
    expect(production.series?.title).toBe('Night Wagon');
    expect(production.coverAssetId).toBe(studio.media.get(sha(path.join(root, 'review/posters/ch-ep-take9.jpg')))!.id);
    const take9 = production.cutBodies.get('take9')!;
    expect(take9).toMatchObject({ kind: 'cut', status: 'approved', order: 1, notes: 'Opens on the road.', createdAt: Date.parse('2026-10-19T06:55:51.502Z'), source: { cut: 'docs/cuts/ep-take9.cut.json', rendered: 'takes/ep-take9.mp4' } });
    const cut = take9.cut as { segments: Array<{ src: string; audio?: { src: string } }>; lines: Array<{ src: string }>; output?: string; media: unknown };
    const assetOf = (file: string) => `asset:${studio.media.get(sha(path.join(root, file)))!.id}`;
    expect(cut.segments.map((s) => s.src)).toEqual([assetOf('takes/road.mp4'), assetOf('takes/dash.mp4'), 'color:black']);
    expect(cut.segments[1].audio?.src).toBe(assetOf('takes/road.mp4'));
    expect(cut.lines[0].src).toBe(assetOf('audio/line.wav'));
    expect(cut.output).toBeUndefined();
    expect(JSON.stringify(cut)).not.toContain(root);
    // Its words name the same assets, so they still apply.
    const words = take9.words as { lines: Record<string, { fingerprint: { source: string } }> };
    expect(words.lines.hello.fingerprint.source).toBe(assetOf('audio/line.wav'));
    expect(take9.renderedAssetId).toBe(assetOf('takes/ep-take9.mp4').slice('asset:'.length));
    expect(Object.keys(take9.thumbs!)).toEqual(['open', 'dash']);

    // Take 10 is Take 9 merged with its changes.
    const take10 = production.cutBodies.get('take10')!.cut as { segments: Array<{ id: string; src: string }> };
    expect(take10.segments.map((s) => s.id)).toEqual(['open', 'dash', 'black']);
    expect(take10.segments[1].src).toBe(assetOf('takes/yell.mp4'));
    expect(production.cutBodies.get('take9-review')!.renderedAssetId).toBe(take9.renderedAssetId);
    expect(production.cutBodies.get('take1')).toMatchObject({ kind: 'rendered', order: 0, status: 'none', renderedAssetId: assetOf('review/clips/ch-ep.mp4').slice('asset:'.length), source: { rendered: 'review/clips/ch-ep.mp4' } });
    expect(studio.patches.at(-1)).toEqual({ approvedCutId: 'take9', currentCutId: 'take10' });
    expect(describePush(report)).toBe(`Episode — 4 cuts (2 cut files, 2 rendered); uploaded ${report.uploaded.length} files (0.0 MB), reused 0 (0.0 MB)`);
  });

  it('uploads nothing the second time, and replaces the same cuts', async () => {
    const before = studio.uploads.length;
    const first = new Map(studio.productions.get('ep')!.cutBodies);
    const report = await pushProduction(studio, manifest(), options);
    expect(studio.uploads.length).toBe(before);
    expect(report.uploaded).toEqual([]);
    expect(report.reused.length).toBe(before);
    expect(studio.productions.size).toBe(1);
    expect(studio.productions.get('ep')!.cutBodies).toEqual(first);
    expect(report.cuts.removed).toEqual([]);
  });

  it('removes cuts the manifest no longer lists', async () => {
    const m = manifest();
    const trimmed = { ...m, cuts: m.cuts.filter((cut) => cut.id !== 'take10'), current: null };
    const report = await pushProduction(studio, trimmed, { ...options, resetStatus: true });
    expect(report.cuts.removed).toEqual(['take10']);
    expect(studio.deleted).toEqual(['take10']);
    expect(studio.patches.at(-1)).toEqual({ approvedCutId: 'take9', currentCutId: 'take9-review' });
  });

  it('shares media between productions: a take another one uploaded is reused', async () => {
    const before = studio.uploads.length;
    const other = manifest({ slug: 'ep2', title: 'Episode 2', series: { title: 'Night Wagon', slug: 'night-wagon' }, approved: undefined, cover: undefined,
      cuts: [{ id: 'take1', cut: 'docs/cuts/ep-take9.cut.json', label: 'Take 1', status: 'review' }] });
    const report = await pushProduction(studio, other, options);
    expect(studio.uploads.length).toBe(before);
    expect(report.uploaded).toEqual([]);
    expect(describeTotals([report, report])).toContain('2 productions, 2 cuts; uploaded 0 files');
  });

  it('stops before sending anything when a file is missing', async () => {
    const before = studio.uploads.length;
    const missing = manifest({ slug: 'ep3', cuts: [{ id: 'gone', rendered: 'review/clips/nope.mp4', label: 'Gone' }], approved: undefined });
    await expect(pushProduction(studio, missing, options)).rejects.toThrow('Missing media file');
    expect(studio.uploads.length).toBe(before);
    expect(studio.productions.has('ep3')).toBe(false);
  });
});

describe('production push and reviews made in Studio', () => {
  const studio = new FakeStudio();
  const slug = 'ep-reviewed';
  const statuses = () => Object.fromEntries([...studio.productions.get(slug)!.cutBodies].map(([id, body]) => [id, body.status]));

  it('sets statuses and the approved and current cut from the manifest when it creates the production', async () => {
    const report = await pushProduction(studio, manifest({ slug }), options);
    expect(statuses()).toEqual({ take1: 'none', take9: 'approved', 'take9-review': 'none', take10: 'review' });
    expect(studio.patches).toEqual([{ approvedCutId: 'take9', currentCutId: 'take10' }]);
    expect([report.keptStatus, report.keptPointers]).toEqual([[], []]);
  });

  it('keeps the statuses, approved cut and current cut set in Studio, and sets a status only on a cut it creates', async () => {
    // In Studio: Take 9 goes back to review, Take 10 is approved and circled, and Take 9 is shown first.
    const production = studio.productions.get(slug)!;
    production.cuts = production.cuts.map((cut) => (cut.id === 'take9' ? { ...cut, status: 'review' } : cut.id === 'take10' ? { ...cut, status: 'approved' } : cut));
    Object.assign(production, { approvedCutId: 'take10', currentCutId: 'take9' });

    const m = manifest({ slug });
    const take11 = { ...m.cuts[3], id: 'take11', label: 'Take 11', status: 'review' as const };
    const report = await pushProduction(studio, { ...m, cuts: [...m.cuts, take11] }, options);
    expect(statuses()).toEqual({ take1: 'none', take9: 'review', 'take9-review': 'none', take10: 'approved', take11: 'review' });
    expect(studio.patches).toHaveLength(1);
    expect(production).toMatchObject({ approvedCutId: 'take10', currentCutId: 'take9' });
    expect(report.keptStatus).toEqual([
      { cut: 'take9', status: 'review', manifest: 'approved' },
      { cut: 'take10', status: 'approved', manifest: 'review' },
    ]);
    expect(report.keptPointers).toEqual([
      { pointer: 'approved', studio: 'take10', manifest: 'take9' },
      { pointer: 'current', studio: 'take9', manifest: 'take11' },
    ]);
    expect(describePush(report)).toEndWith('; kept from Studio: take9 review, take10 approved, approved take10, current take9');
  });

  it('makes them all match the manifest again with resetStatus', async () => {
    const report = await pushProduction(studio, manifest({ slug }), { ...options, resetStatus: true });
    expect(statuses()).toEqual({ take1: 'none', take9: 'approved', 'take9-review': 'none', take10: 'review' });
    expect(studio.patches.at(-1)).toEqual({ approvedCutId: 'take9', currentCutId: 'take10' });
    expect([report.keptStatus, report.keptPointers]).toEqual([[], []]);
    expect(report.cuts.removed).toEqual(['take11']);
  });
});

describe('production push posters', () => {
  it('gives every cut with a rendered video a poster', async () => {
    const studio = new FakeStudio();
    const made: string[] = [];
    const posters = async (video: string) => {
      made.push(video);
      const file = path.join(dir, 'posters', `${path.basename(video)}.jpg`);
      write(file, `poster of ${path.basename(video)}`);
      return file;
    };
    await pushProduction(studio, manifest({ slug: 'ep-posters' }), { ...options, posters });
    const production = studio.productions.get('ep-posters')!;
    const posterOf = (video: string) => studio.media.get(sha(path.join(dir, 'posters', `${path.basename(video)}.jpg`)))!.id;
    expect(production.cutBodies.get('take1')!.posterAssetId).toBe(posterOf('review/clips/ch-ep.mp4'));
    expect(production.cutBodies.get('take9')!.posterAssetId).toBe(posterOf('takes/ep-take9.mp4'));
    expect(production.cutBodies.get('take10')!.posterAssetId).toBe(posterOf('takes/ep-take10.mp4'));
    expect(production.cutBodies.get('take9-review')!.posterAssetId).toBe(posterOf('review/clips/ch-ep-take9.mp4'));
    expect(made.map((video) => path.basename(video))).toEqual(['ch-ep.mp4', 'ep-take9.mp4', 'ch-ep-take9.mp4', 'ep-take10.mp4']);
    // Without a poster maker, cuts carry none.
    await pushProduction(studio, manifest({ slug: 'ep-plain' }), options);
    expect(studio.productions.get('ep-plain')!.cutBodies.get('take1')!.posterAssetId).toBeUndefined();
  });
});
