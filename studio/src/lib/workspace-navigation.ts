import type { MediaType } from './media-types';
import { workspaceRoute, type WorkspaceSnapshot } from './workspace';

export const WORK_PAGE_SIZE = 50;
export const FIND_LIMIT = 20;
export type WorkItem = { key: string; href: string; title: string; detail: string; search: string; pinned: boolean; visitedAt: number; type?: MediaType; viewId?: string; draftId?: string };

/** Drafts are independent of the route cache: even a previously closed draft is discoverable. */
export function workspaceItems(state: WorkspaceSnapshot): WorkItem[] {
  const items = new Map<string, WorkItem>();
  for (const view of state.tabs) {
    const route = workspaceRoute(view.href);
    if (!route || !isWorkRoute(view.href)) continue;
    const id = route.draftId ?? view.key.split('/').pop()!.split(':').pop()!;
    const type = view.key.startsWith('/music/') || view.key.startsWith('/studio/music:') ? 'music' : view.key.startsWith('/video/') || view.key.startsWith('/studio/video:') ? 'video' : view.key.startsWith('/image/') || view.key.startsWith('/studio/image:') ? 'image' : view.key.startsWith('/narration/') || view.key.startsWith('/studio:') ? 'narration' : undefined;
    const kind = route.draftId ? (type === 'music' ? 'Music draft' : type === 'video' ? 'Video draft' : type === 'image' ? 'Image draft' : 'Draft') : type === 'music' ? 'Music' : type === 'video' ? 'Video' : type === 'image' ? 'Image' : type === 'narration' ? 'Narration' : 'Playlist';
    items.set(view.key, { type, key: view.key, href: view.href, title: view.title, detail: `${kind} · ${id}`,
      search: `${view.title} ${id}`, pinned: view.pinned === true, visitedAt: view.visitedAt ?? 0, viewId: view.id, draftId: route.draftId });
  }
  for (const [id, draft] of Object.entries(state.drafts)) {
    if (!draft.markdown?.trim() && !Object.keys(draft).length) continue;
    const key = `/studio:${id}`;
    const previous = items.get(key);
    const title = draft.markdown?.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200) || 'Untitled draft';
    items.set(key, { ...previous, key, href: previous?.href ?? `/studio?draft=${encodeURIComponent(id)}`, title,
      type: 'narration', detail: `Draft · ${id}`, search: `${title} ${draft.markdown ?? ''} ${draft.voice?.name ?? ''} ${id}`,
      pinned: previous?.pinned ?? false, visitedAt: previous?.visitedAt ?? 0, draftId: id });
  }
  for (const [id, draft] of Object.entries(state.imageDrafts ?? {})) {
    const key = `/studio/image:${id}`; const previous = items.get(key);
    const title = draft.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200) || 'Untitled image';
    items.set(key, { ...previous, key, href: previous?.href ?? `/studio/image?draft=${encodeURIComponent(id)}`, title,
      type: 'image', detail: `Image draft · ${id}`, search: `${title} ${draft.prompt} ${id}`,
      pinned: previous?.pinned ?? false, visitedAt: previous?.visitedAt ?? 0, draftId: id });
  }
  for (const [id, draft] of Object.entries(state.videoDrafts ?? {})) {
    const key = `/studio/video:${id}`; const previous = items.get(key);
    const title = draft.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200) || 'Untitled video';
    items.set(key, { ...previous, key, href: previous?.href ?? `/studio/video?draft=${encodeURIComponent(id)}`, title,
      type: 'video', detail: `Video draft · ${id}`, search: `${title} ${draft.prompt} ${id}`,
      pinned: previous?.pinned ?? false, visitedAt: previous?.visitedAt ?? 0, draftId: id });
  }
  for (const [id, draft] of Object.entries(state.musicDrafts ?? {})) {
    const key = `/studio/music:${id}`; const previous = items.get(key);
    const title = draft.prompt.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200) || 'Untitled music';
    items.set(key, { ...previous, key, href: previous?.href ?? `/studio/music?draft=${encodeURIComponent(id)}`, title,
      type: 'music', detail: `Music draft · ${id}`, search: `${title} ${draft.prompt} ${id}`,
      pinned: previous?.pinned ?? false, visitedAt: previous?.visitedAt ?? 0, draftId: id });
  }
  return [...items.values()].sort((a, b) => b.visitedAt - a.visitedAt || a.key.localeCompare(b.key));
}

export function isWorkRoute(href: string): boolean {
  const route = workspaceRoute(href);
  return !!route && (!!route.draftId || route.key.startsWith('/narration/') || route.key.startsWith('/image/') || route.key.startsWith('/video/') || route.key.startsWith('/music/') || route.key.startsWith('/playlists:'));
}

export function matchesWork(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

export function workPage(items: WorkItem[], query: string, page: number, size = WORK_PAGE_SIZE) {
  const matches = items.filter((item) => matchesWork(item.search, query));
  const pages = Math.max(1, Math.ceil(matches.length / size));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  return { items: matches.slice((current - 1) * size, current * size), count: matches.length, pages, page: current };
}
