/**
 * The `gallery` fenced block, version 1: parsing, labels, and filtering.
 *
 * A gallery is a JSON body inside a ```gallery fence. It names rows of
 * images (groups) and, for each image, how it was made, what is seen in it,
 * and the feedback recorded on it. The reader renders it as filterable rows
 * of cards with a lightbox. This module holds everything that does not need
 * React, so it can be tested on its own.
 *
 * Parsing never throws. Unknown fields are ignored; a malformed item or group
 * is skipped rather than failing the whole block. Only a body that is not
 * JSON, has no `groups` array, or declares a version other than 1 is refused,
 * and the reader then shows the fence as a normal code block.
 */

export const GALLERY_ORIGINS = ['documented', 'generated', 'unknown'] as const;
export type GalleryOrigin = (typeof GALLERY_ORIGINS)[number];

export const GALLERY_VERDICTS = [
  'accepted',
  'awaiting-feedback',
  'revision-requested',
  'rejected',
] as const;
export type GalleryVerdict = (typeof GALLERY_VERDICTS)[number];

/** A verdict as the filter sees it: `none` is an item with no verdict. */
export type GalleryVerdictFilterValue = GalleryVerdict | 'none';
export const GALLERY_VERDICT_FILTER_VALUES: readonly GalleryVerdictFilterValue[] = [
  ...GALLERY_VERDICTS,
  'none',
];

export type GalleryReview = 'reviewed' | 'pending';

export interface GallerySetting {
  label: string;
  value: string;
}

export interface GalleryReference {
  label: string;
  role: string | null;
  image: string | null;
}

export interface GalleryParent {
  title: string;
  href: string | null;
}

export interface GallerySource {
  label: string;
  /** Always an `http:` or `https:` URL; anything else is dropped while parsing. */
  url: string;
}

export interface GalleryRecord {
  label: string;
  href: string | null;
}

export interface GalleryMade {
  summary: string | null;
  prompt: string | null;
  promptBasis: string | null;
  tool: string | null;
  model: string | null;
  settings: GallerySetting[];
  references: GalleryReference[];
  parent: GalleryParent | null;
  source: GallerySource | null;
  records: GalleryRecord[];
  note: string | null;
}

export interface GalleryItem {
  id: string;
  /**
   * Unique within the block: the group id and the item id. The same work may
   * appear in several groups, so navigation and React keys use this, not `id`.
   */
  key: string;
  title: string;
  image: string;
  href: string | null;
  origin: GalleryOrigin;
  verdict: GalleryVerdict | null;
  review: GalleryReview | null;
  caption: string | null;
  feedback: string | null;
  made: GalleryMade;
}

export interface GalleryGroup {
  id: string;
  title: string;
  summary: string | null;
  href: string | null;
  items: GalleryItem[];
}

export interface GalleryBlock {
  version: 1;
  title: string | null;
  groups: GalleryGroup[];
}

export type GalleryParseResult =
  | { ok: true; block: GalleryBlock }
  | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string, or null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Like `text`, but keeps inner line breaks and spacing (prompts are verbatim). */
function verbatim(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value.replace(/^\s*\n/, '').replace(/\s+$/, '') : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseMade(value: unknown): GalleryMade {
  const made = isObject(value) ? value : {};
  const parent = isObject(made.parent) && text(made.parent.title)
    ? { title: text(made.parent.title)!, href: text(made.parent.href) }
    : null;
  const sourceUrl = isObject(made.source) ? text(made.source.url) : null;
  const source = isObject(made.source) && sourceUrl && isHttpUrl(sourceUrl)
    ? { label: text(made.source.label) ?? sourceUrl, url: sourceUrl }
    : null;
  return {
    summary: text(made.summary),
    prompt: verbatim(made.prompt),
    promptBasis: text(made.promptBasis),
    tool: text(made.tool),
    model: text(made.model),
    settings: list(made.settings, (entry) => {
      if (!isObject(entry)) return null;
      const label = text(entry.label);
      const settingValue = text(entry.value);
      return label && settingValue ? { label, value: settingValue } : null;
    }),
    references: list(made.references, (entry) => {
      if (!isObject(entry)) return null;
      const label = text(entry.label);
      return label ? { label, role: text(entry.role), image: text(entry.image) } : null;
    }),
    parent,
    source,
    records: list(made.records, (entry) => {
      if (!isObject(entry)) return null;
      const label = text(entry.label);
      return label ? { label, href: text(entry.href) } : null;
    }),
    note: text(made.note),
  };
}

function parseItem(value: unknown): GalleryItem | null {
  if (!isObject(value)) return null;
  const id = text(value.id);
  const title = text(value.title);
  const image = text(value.image);
  if (!id || !title || !image) return null;
  return {
    id,
    key: id,
    title,
    image,
    href: text(value.href),
    origin: oneOf(value.origin, GALLERY_ORIGINS) ?? 'unknown',
    verdict: oneOf(value.verdict, GALLERY_VERDICTS),
    review: oneOf(value.review, ['reviewed', 'pending'] as const),
    caption: text(value.caption),
    feedback: verbatim(value.feedback),
    made: parseMade(value.made),
  };
}

/** Parses a `gallery` fence body. Never throws. */
export function parseGalleryBlock(source: string): GalleryParseResult {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { ok: false, reason: 'This gallery could not be read: its body is not valid JSON.' };
  }
  if (!isObject(data)) {
    return { ok: false, reason: 'This gallery could not be read: its body is not a JSON object.' };
  }
  if (data.version !== undefined && data.version !== 1) {
    return { ok: false, reason: 'This gallery uses a format version this Studio does not read.' };
  }
  if (!Array.isArray(data.groups)) {
    return { ok: false, reason: 'This gallery could not be read: it has no groups.' };
  }

  const seenGroups = new Set<string>();
  const groups: GalleryGroup[] = [];
  for (const rawGroup of data.groups) {
    if (!isObject(rawGroup)) continue;
    const id = text(rawGroup.id);
    const title = text(rawGroup.title);
    if (!id || !title || seenGroups.has(id)) continue;
    seenGroups.add(id);
    // An item may repeat across groups (one work, several directions), but
    // not within one group.
    const seenItems = new Set<string>();
    const items = list(rawGroup.items, parseItem)
      .filter((item) => {
        if (seenItems.has(item.id)) return false;
        seenItems.add(item.id);
        return true;
      })
      .map((item) => ({ ...item, key: `${id}/${item.id}` }));
    groups.push({ id, title, summary: text(rawGroup.summary), href: text(rawGroup.href), items });
  }

  return { ok: true, block: { version: 1, title: text(data.title), groups } };
}

export const ORIGIN_LABELS: Record<GalleryOrigin, string> = {
  documented: 'Documented artwork',
  generated: 'Generated study',
  unknown: 'Unknown origin',
};

export const VERDICT_LABELS: Record<GalleryVerdictFilterValue, string> = {
  accepted: 'Accepted',
  'awaiting-feedback': 'Awaiting feedback',
  'revision-requested': 'Revision requested',
  rejected: 'Rejected',
  none: 'No verdict',
};

export const REVIEW_LABELS: Record<GalleryReview, string> = {
  reviewed: 'Reviewed',
  pending: 'Review pending',
};

export const NOT_RECORDED = 'Not recorded';

export function originLabel(origin: GalleryOrigin): string {
  return ORIGIN_LABELS[origin];
}

export function verdictLabel(verdict: GalleryVerdict | null): string {
  return VERDICT_LABELS[verdict ?? 'none'];
}

/** The value, or "Not recorded" when nothing was recorded. Never invents one. */
export function recordedOr(value: string | null): string {
  return value ?? NOT_RECORDED;
}

/** The facts the lightbox always shows, with "Not recorded" for missing ones. */
export function madeFacts(made: GalleryMade): { label: string; value: string; recorded: boolean }[] {
  return [
    { label: 'Tool', value: recordedOr(made.tool), recorded: made.tool !== null },
    { label: 'Model', value: recordedOr(made.model), recorded: made.model !== null },
  ];
}

export interface GalleryFilters {
  /** Group ids to show; empty shows every group. */
  groups: string[];
  /** Origins to show; empty shows every origin. */
  origins: GalleryOrigin[];
  /** Verdicts to show; empty shows every verdict. */
  verdicts: GalleryVerdictFilterValue[];
  /** Hide rejected items, unless the verdict filter asks for them by name. */
  hideRejected: boolean;
}

export const DEFAULT_GALLERY_FILTERS: GalleryFilters = {
  groups: [],
  origins: [],
  verdicts: [],
  hideRejected: true,
};

export function isDefaultFilters(filters: GalleryFilters): boolean {
  return (
    filters.groups.length === 0 &&
    filters.origins.length === 0 &&
    filters.verdicts.length === 0 &&
    filters.hideRejected === DEFAULT_GALLERY_FILTERS.hideRejected
  );
}

/** Adds the value to the selection, or removes it when it is already there. */
export function toggleValue<T>(selection: readonly T[], value: T): T[] {
  return selection.includes(value)
    ? selection.filter((entry) => entry !== value)
    : [...selection, value];
}

export function itemMatches(item: GalleryItem, filters: GalleryFilters): boolean {
  const verdict: GalleryVerdictFilterValue = item.verdict ?? 'none';
  if (filters.origins.length > 0 && !filters.origins.includes(item.origin)) return false;
  if (filters.verdicts.length > 0 && !filters.verdicts.includes(verdict)) return false;
  if (filters.hideRejected && verdict === 'rejected' && !filters.verdicts.includes('rejected')) {
    return false;
  }
  return true;
}

export interface GalleryRow {
  group: GalleryGroup;
  items: GalleryItem[];
}

/** The rows left after filtering, in block order. Rows with no items are dropped. */
export function filterGallery(block: GalleryBlock, filters: GalleryFilters): GalleryRow[] {
  const rows: GalleryRow[] = [];
  for (const group of block.groups) {
    if (filters.groups.length > 0 && !filters.groups.includes(group.id)) continue;
    const items = group.items.filter((item) => itemMatches(item, filters));
    if (items.length > 0) rows.push({ group, items });
  }
  return rows;
}

/** Every visible item, row by row, in the order the lightbox steps through. */
export function visibleItemOrder(rows: readonly GalleryRow[]): GalleryItem[] {
  return rows.flatMap((row) => row.items);
}

export function countItems(block: GalleryBlock): number {
  return block.groups.reduce((total, group) => total + group.items.length, 0);
}

/**
 * The item `delta` steps from `currentKey` among the visible items, or null at
 * either end or when the current item is no longer visible.
 */
export function stepItem(
  order: readonly GalleryItem[],
  currentKey: string,
  delta: number,
): GalleryItem | null {
  const index = order.findIndex((item) => item.key === currentKey);
  if (index < 0) return null;
  return order[index + delta] ?? null;
}

/** The origins and verdicts the block actually uses, in label order, for the filter chips. */
export function presentFacets(block: GalleryBlock): {
  origins: GalleryOrigin[];
  verdicts: GalleryVerdictFilterValue[];
} {
  const origins = new Set<GalleryOrigin>();
  const verdicts = new Set<GalleryVerdictFilterValue>();
  for (const group of block.groups) {
    for (const item of group.items) {
      origins.add(item.origin);
      verdicts.add(item.verdict ?? 'none');
    }
  }
  return {
    origins: GALLERY_ORIGINS.filter((origin) => origins.has(origin)),
    verdicts: GALLERY_VERDICT_FILTER_VALUES.filter((verdict) => verdicts.has(verdict)),
  };
}
