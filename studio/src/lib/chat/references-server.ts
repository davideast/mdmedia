/**
 * Unified server-side `#` reference discovery across all mdmedia Studio stores:
 * - Media Library (`narration`, `video`, `image`, `music`, `sfx`, `analysis`)
 * - Document Trees & Individual Markdown Tree Documents (`tree`, `tree-doc`)
 * - Productions & Cuts (`production`, `cut`)
 * - Saved Storyboards (`storyboard`)
 * - Characters & Versions (`character`: `person` and `thing` props + reference stills)
 * - Playlists (`playlist`)
 *
 * Every store read is isolated via `Promise.allSettled` and gated by `hasScope(caller, ...)`.
 */

import { hasScope, type Caller } from '../api-auth';
import {
  getCharacterVersion,
  listCharacters,
  type CharacterSummary,
  type CharacterVersionResource,
} from '../characters-server';
import { allowedMediaTypes, listMedia } from '../media-catalog-server';
import type { MediaSummary, MediaType } from '../media-types';
import { listPlaylists, type PlaylistSummary } from '../playlists-server';
import { listProductions } from '../productions-server';
import type { ProductionSummary } from '../productions';
import { listStoryboards } from '../storyboard-server';
import type { StoryboardSummary } from '../storyboard';
import type { TreeDetail, TreeSummary } from '../tree-types';
import { getServerTreeStore } from '../trees-server';
import {
  formatChatEntityUri,
  isChatReferenceKind,
  isMediaReferenceKind,
  matchesReferenceCategory,
  referenceKindLabel,
  routeForEntityReference,
} from './references';
import {
  formatClockSeconds,
  type ChatEntityReference,
  type ChatReferenceCategory,
  type ChatReferenceKind,
} from './types';

export interface ReferenceSearchDeps {
  listMedia: (
    caller: Caller,
    url: URL,
  ) => Promise<{ items: MediaSummary[]; indexing: boolean }>;
  listTrees: (uid: string) => Promise<TreeSummary[]>;
  getTree: (uid: string, treeId: string) => Promise<TreeDetail>;
  listProductions: (
    uid: string,
    origin: string,
  ) => Promise<{ productions: ProductionSummary[] }>;
  listStoryboards: (uid: string) => Promise<{ storyboards: StoryboardSummary[] }>;
  listCharacters: (
    uid: string,
    origin: string,
  ) => Promise<{ characters: CharacterSummary[] }>;
  getCharacterVersion: (
    uid: string,
    idOrSlug: string,
    version: number,
    origin: string,
  ) => Promise<CharacterVersionResource>;
  listPlaylists: (uid: string) => Promise<PlaylistSummary[]>;
}

function defaultDeps(): ReferenceSearchDeps {
  return {
    listMedia: (caller, url) => listMedia(caller, url),
    listTrees: (uid) => getServerTreeStore().listTrees(uid),
    getTree: (uid, treeId) => getServerTreeStore().getTree(uid, treeId),
    listProductions: (uid, origin) =>
      listProductions(uid, origin) as unknown as Promise<{
        productions: ProductionSummary[];
      }>,
    listStoryboards: (uid) => listStoryboards(uid),
    listCharacters: (uid, origin) => listCharacters(uid, origin),
    getCharacterVersion: (uid, idOrSlug, version, origin) =>
      getCharacterVersion(uid, idOrSlug, version, origin),
    listPlaylists: (uid) => listPlaylists(uid),
  };
}

export interface SearchChatReferencesOptions {
  origin: string;
  query?: string;
  category?: ChatReferenceCategory;
  kind?: ChatReferenceKind | null;
  activeRoute?: string | null;
  limit?: number;
}

function formatShortDurationMs(durationMs: number | undefined): string | null {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const secs = Math.max(1, Math.round(durationMs / 1000));
  return formatClockSeconds(secs);
}

function scoreCandidate(
  ref: ChatEntityReference,
  normalizedQuery: string,
  queryTokens: readonly string[],
  activeRoute: string | null,
): number | null {
  const titleLower = ref.title.toLowerCase();
  const idLower = ref.id.toLowerCase();
  const subLower = (ref.subId ?? '').toLowerCase();
  const subtitleLower = (ref.subtitle ?? '').toLowerCase();
  const metaLower = (ref.metaLabel ?? '').toLowerCase();
  const kindLabelLower = referenceKindLabel(ref.kind, ref.characterKind).toLowerCase();
  const haystack = `${titleLower} ${idLower} ${subLower} ${subtitleLower} ${metaLower} ${ref.kind} ${kindLabelLower}`;

  for (const token of queryTokens) {
    if (!haystack.includes(token)) {
      return null;
    }
  }

  let score = 0;

  if (activeRoute) {
    const cleanActive = activeRoute.split('?')[0] ?? activeRoute;
    const cleanHref = ref.href.split('?')[0] ?? ref.href;
    if (cleanHref === cleanActive) {
      score += 5000;
    } else if (
      cleanActive.length > 1 &&
      (cleanActive.startsWith(`${cleanHref}/`) || cleanHref.startsWith(`${cleanActive}/`))
    ) {
      score += 1200;
    }
  }

  if (normalizedQuery) {
    if (
      titleLower === normalizedQuery ||
      idLower === normalizedQuery ||
      `${idLower}@${subLower}` === normalizedQuery
    ) {
      score += 1400;
    } else if (
      titleLower.startsWith(normalizedQuery) ||
      idLower.startsWith(normalizedQuery)
    ) {
      score += 800;
    } else if (
      subLower.endsWith(`/${normalizedQuery}`) ||
      subLower.startsWith(normalizedQuery) ||
      titleLower.includes(` ${normalizedQuery}`)
    ) {
      score += 500;
    } else if (titleLower.includes(normalizedQuery)) {
      score += 320;
    } else if (subLower.includes(normalizedQuery) || subtitleLower.includes(normalizedQuery)) {
      score += 160;
    } else {
      score += 60;
    }
  }

  return score;
}

export async function searchChatReferences(
  caller: Caller,
  options: SearchChatReferencesOptions,
  customDeps?: Partial<ReferenceSearchDeps>,
): Promise<{ items: ChatEntityReference[] }> {
  const deps: ReferenceSearchDeps = { ...defaultDeps(), ...customDeps };
  const rawQuery = (options.query ?? '').trim();
  const normalizedQuery = rawQuery.toLowerCase();
  const queryTokens = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
  const category: ChatReferenceCategory = options.category ?? 'all';
  const kindFilter: ChatReferenceKind | null =
    options.kind && isChatReferenceKind(options.kind) ? options.kind : null;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 30), 1), 60);
  const activeRoute = options.activeRoute?.trim() || null;

  const shouldIncludeKind = (k: ChatReferenceKind): boolean => {
    if (kindFilter && k !== kindFilter) return false;
    return matchesReferenceCategory(k, category);
  };

  const tasks: Array<Promise<ChatEntityReference[]>> = [];

  // 1. Media items (`narration`, `video`, `image`, `music`, `sfx`, `analysis`)
  const allowedMedia = allowedMediaTypes(caller).filter((t) =>
    shouldIncludeKind(t as ChatReferenceKind),
  );
  if (allowedMedia.length > 0) {
    tasks.push(
      (async () => {
        const url = new URL('/api/v1/media', options.origin);
        if (allowedMedia.length === 1) {
          url.searchParams.set('type', allowedMedia[0]!);
        }
        // Pass single-token or full query when searching media; if multi-word, let our scorer filter across metadata too.
        if (rawQuery && queryTokens.length === 1) {
          url.searchParams.set('q', rawQuery.slice(0, 180));
        }
        const res = await deps.listMedia(caller, url);
        const out: ChatEntityReference[] = [];
        for (const item of res.items) {
          const kind = item.type as MediaType & ChatReferenceKind;
          if (!isMediaReferenceKind(kind) || !shouldIncludeKind(kind)) continue;
          const clock = formatShortDurationMs(item.durationMs);
          const metaLabel =
            kind === 'sfx'
              ? clock
                ? `SFX · ${clock}`
                : 'SFX'
              : kind === 'analysis'
                ? 'ANALYSIS'
                : kind === 'image'
                  ? 'IMG'
                  : clock ?? kind.toUpperCase();
          out.push({
            uri: formatChatEntityUri({ kind, id: item.id }),
            kind,
            id: item.id,
            title: item.title || referenceKindLabel(kind),
            subtitle:
              item.status !== 'ready'
                ? `${referenceKindLabel(kind)} · ${item.status}`
                : referenceKindLabel(kind),
            metaLabel,
            thumbnailAssetId: item.thumbnailAssetId ?? null,
            href: routeForEntityReference(kind, item.id),
            updatedAt: item.updatedAt || item.createdAt || 0,
          });
        }
        return out;
      })(),
    );
  }

  // 2. Trees & Tree Documents (`tree`, `tree-doc`)
  if (
    hasScope(caller, 'trees:manage') &&
    (shouldIncludeKind('tree') || shouldIncludeKind('tree-doc'))
  ) {
    tasks.push(
      (async () => {
        const trees = await deps.listTrees(caller.uid);
        const boundedTrees = trees.slice(0, 20);
        const out: ChatEntityReference[] = [];

        if (shouldIncludeKind('tree')) {
          for (const tree of boundedTrees) {
            out.push({
              uri: formatChatEntityUri({ kind: 'tree', id: tree.id }),
              kind: 'tree',
              id: tree.id,
              title: tree.title || 'Untitled tree',
              subtitle: tree.description?.trim() || 'Document tree',
              metaLabel: `${tree.docCount} doc${tree.docCount === 1 ? '' : 's'}`,
              href: routeForEntityReference('tree', tree.id),
              updatedAt: tree.updatedAt || tree.createdAt || 0,
            });
          }
        }

        if (shouldIncludeKind('tree-doc') && boundedTrees.length > 0) {
          const details = await Promise.allSettled(
            boundedTrees.map((t) => deps.getTree(caller.uid, t.id)),
          );
          for (const settled of details) {
            if (settled.status !== 'fulfilled') continue;
            const detail = settled.value;
            for (const node of Object.values(detail.nodes)) {
              if (node.kind !== 'doc') continue;
              out.push({
                uri: formatChatEntityUri({
                  kind: 'tree-doc',
                  id: detail.id,
                  subId: node.path,
                }),
                kind: 'tree-doc',
                id: detail.id,
                subId: node.path,
                title: node.name || node.path.split('/').pop() || node.path,
                subtitle: `${detail.title} / ${node.path}`,
                metaLabel: node.narrationStatus === 'ready' ? 'Voiced · DOC' : 'DOC',
                href: routeForEntityReference('tree-doc', detail.id, node.path),
                updatedAt: node.updatedAt || detail.updatedAt || 0,
              });
            }
          }
        }

        return out;
      })(),
    );
  }

  // 3. Productions & Cuts (`production`, `cut`)
  if (
    hasScope(caller, 'productions:read') &&
    (shouldIncludeKind('production') || shouldIncludeKind('cut'))
  ) {
    tasks.push(
      (async () => {
        const { productions } = await deps.listProductions(caller.uid, options.origin);
        const out: ChatEntityReference[] = [];

        for (const prod of productions) {
          const fallbackPoster =
            prod.coverAssetId ??
            prod.cuts.find((c) => c.id === prod.approvedCutId)?.posterAssetId ??
            prod.cuts.at(-1)?.posterAssetId ??
            null;

          if (shouldIncludeKind('production')) {
            const subParts = [
              prod.series?.title ?? null,
              prod.cast.length > 0
                ? `${prod.cast.length} cast`
                : null,
            ].filter(Boolean);
            out.push({
              uri: formatChatEntityUri({ kind: 'production', id: prod.id }),
              kind: 'production',
              id: prod.id,
              title: prod.title || prod.slug || 'Untitled production',
              subtitle: subParts.length > 0 ? subParts.join(' · ') : 'Production',
              metaLabel: `${prod.cutCount} cut${prod.cutCount === 1 ? '' : 's'}`,
              thumbnailAssetId: fallbackPoster,
              href: routeForEntityReference('production', prod.id),
              updatedAt: prod.updatedAt || prod.createdAt || 0,
            });
          }

          if (shouldIncludeKind('cut')) {
            for (const cut of prod.cuts) {
              const clock =
                typeof cut.lengthSeconds === 'number' && cut.lengthSeconds > 0
                  ? formatClockSeconds(cut.lengthSeconds)
                  : null;
              const statusText =
                cut.status === 'final'
                  ? 'Final cut'
                  : cut.status === 'approved'
                    ? 'Approved cut'
                    : cut.status === 'review'
                      ? 'In review'
                      : 'Cut';
              out.push({
                uri: formatChatEntityUri({
                  kind: 'cut',
                  id: prod.id,
                  subId: cut.id,
                }),
                kind: 'cut',
                id: prod.id,
                subId: cut.id,
                title: `${prod.title} — ${cut.label || cut.id}`,
                subtitle: statusText,
                metaLabel: clock ?? 'CUT',
                cutStatus: cut.status,
                thumbnailAssetId: cut.posterAssetId ?? fallbackPoster,
                href: routeForEntityReference('cut', prod.id, cut.id),
                updatedAt: cut.createdAt || prod.updatedAt || 0,
              });
            }
          }
        }

        return out;
      })(),
    );
  }

  // 4. Storyboards (`storyboard`)
  if (hasScope(caller, 'storyboards:read') && shouldIncludeKind('storyboard')) {
    tasks.push(
      (async () => {
        const { storyboards } = await deps.listStoryboards(caller.uid);
        return storyboards.map((sb) => {
          const safeThumb =
            typeof sb.image === 'string' &&
            (sb.image.startsWith('/') ||
              sb.image.startsWith('https://') ||
              sb.image.startsWith('data:image/'))
              ? sb.image
              : null;
          return {
            uri: formatChatEntityUri({ kind: 'storyboard', id: sb.id }),
            kind: 'storyboard' as const,
            id: sb.id,
            title: sb.title || 'Untitled storyboard',
            subtitle: 'Storyboard',
            metaLabel: `${sb.beatCount} beat${sb.beatCount === 1 ? '' : 's'}`,
            thumbnailUrl: safeThumb,
            href: routeForEntityReference('storyboard', sb.id),
            updatedAt: sb.updatedAt || 0,
          };
        });
      })(),
    );
  }

  // 5. Characters (`character`: `person` | `thing`)
  if (hasScope(caller, 'productions:read') && shouldIncludeKind('character')) {
    tasks.push(
      (async () => {
        const { characters } = await deps.listCharacters(caller.uid, options.origin);
        const bounded = characters.slice(0, 40);
        const versionReads = await Promise.allSettled(
          bounded.map((ch) =>
            ch.latestVersion > 0
              ? deps.getCharacterVersion(caller.uid, ch.id, ch.latestVersion, options.origin)
              : Promise.resolve(null),
          ),
        );

        return bounded.map((ch, idx) => {
          const settled = versionReads[idx];
          const ver =
            settled && settled.status === 'fulfilled' ? settled.value : null;
          const firstStillAssetId = ver
            ? Object.values(ver.stills)[0] ?? null
            : null;
          const versionStr =
            ch.latestVersion > 0 ? String(ch.latestVersion) : undefined;
          const registerSnippet = ver?.character.delivery?.register?.trim();
          const subtitle = registerSnippet
            ? registerSnippet.length > 72
              ? `${registerSnippet.slice(0, 71).trimEnd()}…`
              : registerSnippet
            : ch.kind === 'thing'
              ? 'Prop character'
              : 'Character';

          return {
            uri: formatChatEntityUri({
              kind: 'character',
              id: ch.slug || ch.id,
              subId: versionStr,
            }),
            kind: 'character' as const,
            id: ch.slug || ch.id,
            ...(versionStr ? { subId: versionStr } : {}),
            title: ch.name || ch.slug || ch.id,
            subtitle,
            metaLabel: versionStr ? `${ch.slug}@${versionStr}` : `@${ch.slug}`,
            characterKind: ch.kind,
            thumbnailAssetId: firstStillAssetId,
            href: routeForEntityReference('character', ch.slug || ch.id, versionStr),
            updatedAt: ch.updatedAt || ch.createdAt || 0,
          };
        });
      })(),
    );
  }

  // 6. Playlists (`playlist`)
  if (hasScope(caller, 'playlists:manage') && shouldIncludeKind('playlist')) {
    tasks.push(
      (async () => {
        const playlists = await deps.listPlaylists(caller.uid);
        return playlists.map((pl) => {
          const clock = formatShortDurationMs(pl.durationMs);
          const countPart = `${pl.itemCount} track${pl.itemCount === 1 ? '' : 's'}`;
          return {
            uri: formatChatEntityUri({ kind: 'playlist', id: pl.id }),
            kind: 'playlist' as const,
            id: pl.id,
            title: pl.title || 'Untitled playlist',
            subtitle: pl.description?.trim() || 'Playlist',
            metaLabel: clock ? `${countPart} · ${clock}` : countPart,
            href: routeForEntityReference('playlist', pl.id),
            updatedAt: pl.updatedAt || pl.createdAt || 0,
          };
        });
      })(),
    );
  }

  const settledGroups = await Promise.allSettled(tasks);
  const allCandidates: ChatEntityReference[] = [];
  for (const res of settledGroups) {
    if (res.status === 'fulfilled') {
      allCandidates.push(...res.value);
    }
  }

  const scored: Array<{ ref: ChatEntityReference; score: number }> = [];
  for (const ref of allCandidates) {
    const score = scoreCandidate(ref, normalizedQuery, queryTokens, activeRoute);
    if (score !== null) {
      scored.push({ ref, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const timeDiff = (b.ref.updatedAt ?? 0) - (a.ref.updatedAt ?? 0);
    if (timeDiff !== 0) return timeDiff;
    return a.ref.title.localeCompare(b.ref.title);
  });

  // When browsing `#` with an empty query under `all` categories, prevent a single abundant kind (e.g. 50 narrations) from hiding trees, storyboards, productions, or characters.
  if (!normalizedQuery && category === 'all' && !kindFilter) {
    const perKindCount = new Map<ChatReferenceKind, number>();
    const primary: ChatEntityReference[] = [];
    const overflow: ChatEntityReference[] = [];

    for (const entry of scored) {
      const count = perKindCount.get(entry.ref.kind) ?? 0;
      const isFocal = entry.score >= 1000;
      if (isFocal || count < 4) {
        primary.push(entry.ref);
        perKindCount.set(entry.ref.kind, count + 1);
      } else {
        overflow.push(entry.ref);
      }
    }

    return {
      items: [...primary, ...overflow].slice(0, limit),
    };
  }

  return {
    items: scored.slice(0, limit).map((s) => s.ref),
  };
}
