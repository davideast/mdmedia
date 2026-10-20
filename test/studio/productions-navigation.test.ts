import { describe, expect, it } from 'bun:test';
import { WorkspaceStore, workspaceRoute } from '../../studio/src/lib/workspace';
import { isWorkRoute, matchesWork, workspaceItems } from '../../studio/src/lib/workspace-navigation';
import {
  clockLength,
  cutPageTitle,
  labelDetail,
  newestFirst,
  productionPicture,
  productionRoute,
  productionSections,
  productionStatus,
  shortLabel,
  statusPatch,
  type ProductionCutSummary,
  type ProductionList,
  type ProductionSummary,
} from '../../studio/src/lib/productions';

const cut = (id: string, order: number, status: ProductionCutSummary['status'], extra: Partial<ProductionCutSummary> = {}): ProductionCutSummary => ({
  id, label: `Take ${order + 1}`, status, kind: 'rendered', lengthSeconds: 8, createdAt: 1000 + order, order, renderedAssetId: `pm${id}`,
  posterAssetId: null, notes: '', notesTruncated: false, links: { self: '', rendered: null }, ...extra,
});
const production = (id: string, title: string, cuts: ProductionCutSummary[], extra: Partial<ProductionSummary> = {}): ProductionSummary => ({
  id, slug: id, title, series: null, coverAssetId: null, currentCutId: cuts.at(-1)?.id ?? null, approvedCutId: null, cutCount: cuts.length, cuts,
  createdAt: 1, updatedAt: 1, activityAt: Math.max(...cuts.map((c) => c.createdAt)), links: { self: '', cover: null, coverThumbnail: null }, ...extra,
});

describe('production status reads like the review page', () => {
  it("is the approved cut's when there is one, else Needs review if any cut waits, else No verdict", () => {
    const argument = production('a', 'Night Wagon: The Argument', [cut('take9', 8, 'approved'), cut('take10', 9, 'review')], { approvedCutId: 'take9' });
    expect(productionStatus(argument)).toBe('approved');
    expect(productionStatus(production('b', 'Bellamy', [cut('take6', 5, 'final'), cut('rex', 6, 'review')], { approvedCutId: 'take6' }))).toBe('final');
    expect(productionStatus(production('c', 'Big Hal', [cut('t1', 0, 'none'), cut('t5', 4, 'review')]))).toBe('review');
    expect(productionStatus(production('d', 'Meridian', [cut('t2', 0, 'none')]))).toBe('none');
  });

  it('approving or finalising a version makes it the approved cut; other verdicts only set the status', () => {
    expect(statusPatch('take10', 'approved')).toEqual({ approvedCutId: 'take10', cuts: [{ id: 'take10', status: 'approved' }] });
    expect(statusPatch('take10', 'final')).toEqual({ approvedCutId: 'take10', cuts: [{ id: 'take10', status: 'final' }] });
    expect(statusPatch('take10', 'review')).toEqual({ cuts: [{ id: 'take10', status: 'review' }] });
  });
});

describe('the productions list', () => {
  it('groups a series under its heading and the rest under Standalone, most recent activity first', () => {
    const list: ProductionList = {
      productions: [
        production('rigg', 'RIGG', [cut('t1', 0, 'none', { createdAt: 50 })]),
        production('drive', 'Night Wagon: Drive-In', [cut('t1', 0, 'review', { createdAt: 300 })], { series: { id: 'nw', title: 'Night Wagon' } }),
        production('arg', 'Night Wagon: The Argument', [cut('t1', 0, 'none', { createdAt: 200 })], { series: { id: 'nw', title: 'Night Wagon' } }),
        production('bell', 'Bellamy Ranch', [cut('t1', 0, 'final', { createdAt: 400 })]),
      ],
      series: [{ id: 'nw', title: 'Night Wagon', slug: 'night-wagon', productionIds: ['drive', 'arg'] }],
    };
    const sections = productionSections(list);
    expect(sections.map((s) => [s.title, s.productions.map((p) => p.id)])).toEqual([
      ['Night Wagon', ['drive', 'arg']],
      ['Standalone', ['bell', 'rigg']],
    ]);
    expect(productionSections({ productions: [], series: [] })).toEqual([]);
  });

  it("pictures a production by its cover, else its newest cut's poster", () => {
    const cuts = [cut('t1', 0, 'none', { posterAssetId: 'pmold' }), cut('t2', 1, 'none', { posterAssetId: 'pmnew' })];
    expect(productionPicture(production('a', 'A', cuts, { coverAssetId: 'pmcover' }))).toBe('pmcover');
    expect(productionPicture(production('a', 'A', cuts))).toBe('pmnew');
    expect(productionPicture(production('a', 'A', [cut('t1', 0, 'none')]))).toBeNull();
    expect(newestFirst(cuts).map((c) => c.id)).toEqual(['t2', 't1']);
  });

  it('reads labels, lengths and titles the way the pages show them', () => {
    expect(shortLabel('Take 9 (opens on the road)')).toBe('Take 9');
    expect(labelDetail('Take 9 (opens on the road)')).toBe('opens on the road');
    expect(shortLabel('Take 3')).toBe('Take 3');
    expect(labelDetail('Take 3')).toBe('');
    expect(cutPageTitle({ label: 'Take 9 (opens on the road)' }, { title: 'Night Wagon: The Argument' })).toBe('Take 9 · Night Wagon: The Argument');
    expect(clockLength(26.3)).toBe('0:26');
    expect(clockLength(161)).toBe('2:41');
    expect(clockLength(null)).toBe('');
  });
});

describe('productions in Find work, tabs and pins', () => {
  it('parses production and cut routes, and only those', () => {
    expect(productionRoute('/productions/pr1')).toEqual({ productionId: 'pr1' });
    expect(productionRoute('/productions/pr1/cuts/take9')).toEqual({ productionId: 'pr1', cutId: 'take9' });
    expect(productionRoute('/productions')).toBeNull();
    expect(productionRoute('/productions/pr1/cuts')).toBeNull();
  });

  it('treats a production and a cut as work, and the list as a destination', () => {
    expect(isWorkRoute('/productions/pr1')).toBe(true);
    expect(isWorkRoute('/productions/pr1/cuts/take9')).toBe(true);
    expect(isWorkRoute('/productions')).toBe(false);
    expect(workspaceRoute('/productions')?.title).toBe('Productions');
    expect(workspaceRoute('/productions/pr1')?.title).toBe('Production');
    expect(workspaceRoute('/productions/pr1/cuts/take9')?.title).toBe('Cut');
  });

  it('finds them by title and label, shows what they are, pins them and restores them on reload', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const store = new WorkspaceStore('david'); store.restore(storage);
    const page = store.visit('/productions/pr69')!;
    store.updateTab(page.id, { title: 'Night Wagon: The Argument' });
    const take = store.visit('/productions/pr69/cuts/take9')!;
    store.updateTab(take.id, { title: 'Take 9 · Night Wagon: The Argument' });
    store.visit('/productions');
    store.togglePin(take.id);
    store.flush();

    const restored = new WorkspaceStore('david'); restored.restore(storage);
    const items = workspaceItems(restored.getSnapshot());
    const production = items.find((item) => item.key === '/productions/pr69')!;
    const cutItem = items.find((item) => item.key === '/productions/pr69/cuts/take9')!;
    expect(items.some((item) => item.key === '/productions')).toBe(false);
    expect(production).toMatchObject({ title: 'Night Wagon: The Argument', detail: 'Production', pinned: false });
    expect(cutItem).toMatchObject({ title: 'Take 9 · Night Wagon: The Argument', detail: 'Cut', pinned: true, href: '/productions/pr69/cuts/take9' });
    expect(matchesWork(cutItem.search, 'take 9 argument')).toBe(true);
    expect(matchesWork(production.search, 'night wagon')).toBe(true);
    expect(matchesWork(production.search, 'take 9')).toBe(false);
    store.dispose(); restored.dispose();
  });
});
