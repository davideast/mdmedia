/**
 * Productions as the pages show them: status language, grouping by series,
 * labels and lengths. Pure, so it runs on either side and in tests; the
 * shapes come from the API (`productions-server.ts`).
 */

import type { CutStatus, ProductionCutSummary, ProductionList, ProductionSummary } from './productions-server';

export type { CutStatus, ProductionCutResource, ProductionCutSummary, ProductionList, ProductionSummary } from './productions-server';
export type { CastMember } from './characters-server';

/** The review page's words for each status. */
export const STATUS_LABELS: Record<CutStatus, string> = {
  review: 'Needs review',
  approved: 'Approved',
  final: 'Final',
  none: 'No verdict',
};

/** The order a status menu lists them in. */
export const STATUS_ORDER: readonly CutStatus[] = ['review', 'approved', 'final', 'none'];

/**
 * A production's status, as the review page gives a show one: its approved
 * cut's (Approved or Final) when it has one; else Needs review if any cut
 * waits for review; else No verdict.
 */
export function productionStatus(production: Pick<ProductionSummary, 'approvedCutId' | 'cuts'>): CutStatus {
  const approved = production.cuts.find((cut) => cut.id === production.approvedCutId);
  if (approved && (approved.status === 'approved' || approved.status === 'final')) return approved.status;
  return production.cuts.some((cut) => cut.status === 'review') ? 'review' : 'none';
}

/** The newest cut: the last in the production's order. */
export const latestCut = (production: Pick<ProductionSummary, 'cuts'>): ProductionCutSummary | null => production.cuts.at(-1) ?? null;

/** Cuts newest first, as a production page lists them. */
export const newestFirst = <T extends Pick<ProductionCutSummary, 'order' | 'createdAt'>>(cuts: readonly T[]): T[] =>
  [...cuts].sort((a, b) => b.order - a.order || b.createdAt - a.createdAt);

/** The image that stands for a cut in a listing: its poster. */
export function cutPicture(cut: Pick<ProductionCutSummary, 'posterAssetId'>): string | null {
  return cut.posterAssetId ?? null;
}

/** The image that stands for a production: its cover, else its newest cut's poster. */
export function productionPicture(production: Pick<ProductionSummary, 'coverAssetId' | 'cuts'>): string | null {
  return production.coverAssetId ?? newestFirst(production.cuts).map(cutPicture).find(Boolean) ?? null;
}

/** "Take 9 (opens on the road)" reads as "Take 9" where room is short. */
export const shortLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;

/** The parenthetical that tells takes apart: "opens on the road". */
export const labelDetail = (label: string): string => /\(([^)]*)\)\s*$/.exec(label)?.[1]?.trim() ?? '';

/** A cut's page title, for tabs and Find work: "Take 9 · Night Wagon: The Argument". */
export const cutPageTitle = (cut: Pick<ProductionCutSummary, 'label'>, production: Pick<ProductionSummary, 'title'>): string =>
  `${shortLabel(cut.label)} · ${production.title}`;

/** A length as a clock: `0:26`, `2:41`. */
export function clockLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** A cast member's one-line details: "v1 · ElevenLabs “Eric” (text-to-speech, voice swap) · levels from 7 approved lines". */
export function castDetails(member: { version: number; voice: string; referenceLines: number }): string {
  const levels = member.referenceLines > 0 ? `levels from ${member.referenceLines} approved line${member.referenceLines === 1 ? '' : 's'}` : 'levels not measured yet';
  return [`v${member.version}`, member.voice, levels].filter(Boolean).join(' · ');
}

/** "3 versions", "1 version". */
export const versionCount = (count: number): string => `${count} version${count === 1 ? '' : 's'}`;

export interface ProductionSection {
  /** The series' id, or null for productions in no series. */
  id: string | null;
  /** The heading: the series' title, or "Standalone". */
  title: string;
  productions: ProductionSummary[];
}

/**
 * Productions grouped for the list: each series under its own heading, the
 * rest together under "Standalone". Inside a section, most recent activity
 * first; sections in the order of their most recent production, except that
 * Standalone always comes last so a series reads as a set.
 */
export function productionSections(list: ProductionList): ProductionSection[] {
  const activity = (production: ProductionSummary) => production.activityAt ?? production.updatedAt;
  const sorted = [...list.productions].sort((a, b) => activity(b) - activity(a));
  const series = new Map<string, ProductionSection>();
  const standalone: ProductionSummary[] = [];
  for (const production of sorted) {
    if (!production.series) { standalone.push(production); continue; }
    const title = list.series.find((item) => item.id === production.series!.id)?.title || production.series.title;
    const section = series.get(production.series.id) ?? { id: production.series.id, title, productions: [] };
    section.productions.push(production);
    series.set(production.series.id, section);
  }
  return [...series.values(), ...(standalone.length ? [{ id: null, title: 'Standalone', productions: standalone }] : [])];
}

/** The status change a version's status menu sends: approving or finalising a cut also makes it the approved cut. */
export function statusPatch(cutId: string, status: CutStatus): { approvedCutId?: string; cuts: Array<{ id: string; status: CutStatus }> } {
  return status === 'approved' || status === 'final'
    ? { approvedCutId: cutId, cuts: [{ id: cutId, status }] }
    : { cuts: [{ id: cutId, status }] };
}

/** `/productions/{id}` and `/productions/{id}/cuts/{cutId}`, parsed. */
export function productionRoute(path: string): { productionId: string; cutId?: string } | null {
  const match = /^\/productions\/([^/?#]+)(?:\/cuts\/([^/?#]+))?\/?$/.exec(path);
  if (!match) return null;
  return { productionId: decodeURIComponent(match[1]!), ...(match[2] ? { cutId: decodeURIComponent(match[2]) } : {}) };
}
