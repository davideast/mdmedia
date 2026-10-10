import { parseVideoRequest } from './video-request';
import type { ImageDraft, VideoDraft } from './media-types';
import type { Draft } from '../components/shell/narration-provider';

export interface WorkspaceTab {
  id: string;
  key: string;
  href: string;
  title: string;
  scrollTop: number;
  pinned?: boolean;
  visitedAt?: number;
  fields: Record<string, string | boolean | number | null>;
}

export interface WorkspaceSnapshot {
  version: 1;
  tabs: WorkspaceTab[];
  activeId: string | null;
  drafts: Record<string, Partial<Draft>>;
  imageDrafts?: Record<string, ImageDraft>;
  videoDrafts?: Record<string, VideoDraft>;
}

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  keys?: () => string[];
  removeItem?: (key: string) => void;
  exclusive?: (commit: () => void) => Promise<void>;
}

const ORIGIN = 'https://workspace.local';
export const EMPTY_WORKSPACE: WorkspaceSnapshot = { version: 1, tabs: [], activeId: null, drafts: {} };
const PAGE_TITLES: Record<string, string> = {
  '/studio': 'Draft', '/studio/image': 'Image draft', '/studio/video': 'Video draft', '/drafts': 'Drafts', '/pinned': 'Pinned', '/recent': 'Recent', '/library': 'Library', '/queue': 'Activity',
  '/playlists': 'Playlists', '/downloads': 'Downloads', '/settings': 'Settings', '/connect': 'Connect app',
};

/** Persisted v1 `tabs` are a cache of route state, not open UI tabs. Keep the schema
 * compatible so upgrading navigation never discards drafts or unfinished edits. */
export function workspaceRoute(href: string): { href: string; key: string; title: string; draftId?: string } | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || url.pathname === '/' || /^\/(api|_next)(\/|$)/.test(url.pathname)) return null;
  const path = url.pathname.replace(/\/$/, '');
  const draftId = (path === '/studio' || path === '/studio/image' || path === '/studio/video') ? url.searchParams.get('draft') || 'default' : undefined;
  const entity = draftId ?? url.searchParams.get('playlist') ?? url.searchParams.get('track');
  return {
    href: `${path}${url.search}${url.hash}`,
    key: entity ? `${path}:${entity}` : path,
    title: PAGE_TITLES[path] ?? (path.startsWith('/narration/') ? 'Narration' : path.startsWith('/image/') ? 'Image' : path.startsWith('/video/') ? 'Video' : path.startsWith('/profile/') ? 'Profile' : path.split('/').pop() || 'Page'),
    draftId,
  };
}

function readDraft(value: unknown): Partial<Draft> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const draft: Partial<Draft> = {};
  for (const field of ['markdown', 'promptStyle', 'rewriteInstructions', 'deliveryPreset', 'instructionPreset'] as const) {
    if (typeof raw[field] === 'string') draft[field] = raw[field];
  }
  for (const field of ['rewriteForNarration', 'structureMarkdown', 'verbalizeDiagrams'] as const) {
    if (typeof raw[field] === 'boolean') draft[field] = raw[field];
  }
  if (raw.visibility === 'private' || raw.visibility === 'shared' || raw.visibility === 'public') draft.visibility = raw.visibility;
  if (typeof raw.speed === 'number' && Number.isFinite(raw.speed)) draft.speed = raw.speed;
  if (raw.voice && typeof raw.voice === 'object') {
    const voice = raw.voice as Record<string, unknown>;
    if ((voice.provider === 'gemini' || voice.provider === 'elevenlabs') && typeof voice.id === 'string' && typeof voice.name === 'string') {
      draft.voice = { provider: voice.provider, id: voice.id, name: voice.name };
    }
  }
  return draft;
}

function readSnapshot(serialized: string | null): WorkspaceSnapshot {
  try {
      const raw = serialized;
      const saved = raw ? JSON.parse(raw) : null;
      if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return EMPTY_WORKSPACE;
      const tabs: WorkspaceTab[] = [];
      const keys = new Set<string>();
      const ids = new Set<string>();
      for (const tab of saved.tabs) {
        if (typeof tab?.href !== 'string' || typeof tab.id !== 'string') continue;
        const route = workspaceRoute(tab.href);
        if (!route || keys.has(route.key) || ids.has(tab.id)) continue;
        keys.add(route.key); ids.add(tab.id);
        tabs.push({ id: tab.id, key: route.key, href: route.href,
          title: typeof tab.title === 'string' ? tab.title.slice(0, 200) : route.title,
          pinned: tab.pinned === true,
          visitedAt: typeof tab.visitedAt === 'number' && Number.isFinite(tab.visitedAt) ? Math.max(0, tab.visitedAt) : 0,
          scrollTop: typeof tab.scrollTop === 'number' && Number.isFinite(tab.scrollTop) ? Math.max(0, tab.scrollTop) : 0,
          fields: Object.fromEntries(Object.entries(tab.fields && typeof tab.fields === 'object' ? tab.fields : {})
            .filter(([, value]) => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) as WorkspaceTab['fields'] });
      }
      const drafts: Record<string, Partial<Draft>> = Object.create(null);
      if (saved.drafts && typeof saved.drafts === 'object') {
        for (const [id, draft] of Object.entries(saved.drafts)) drafts[id] = readDraft(draft);
      }
      const imageDrafts: Record<string, ImageDraft> = Object.create(null);
      for (const [id, value] of Object.entries(saved.imageDrafts ?? {})) {
        if (!value || typeof value !== 'object') continue;
        const draft = value as Record<string, unknown>;
        imageDrafts[id] = { kind: 'image', prompt: typeof draft.prompt === 'string' ? draft.prompt : '',
          aspectRatio: typeof draft.aspectRatio === 'string' ? draft.aspectRatio : '16:9', resolution: typeof draft.resolution === 'string' ? draft.resolution : '',
          adapt: draft.adapt === true, instructions: typeof draft.instructions === 'string' ? draft.instructions : '',
          referenceAssetId: typeof draft.referenceAssetId === 'string' ? draft.referenceAssetId : null };
      }
      const videoDrafts: Record<string, VideoDraft> = Object.create(null);
      for (const [id, value] of Object.entries(saved.videoDrafts ?? {})) {
        if (!value || typeof value !== 'object') continue;
        const { kind, ...draft } = value as VideoDraft;
        if (kind !== 'video') continue;
        try { videoDrafts[id] = { kind: 'video', ...parseVideoRequest({ ...draft, prompt: draft.prompt || 'defaults' }), prompt: draft.prompt || '' }; } catch { /* Ignore malformed saved options. */ }
      }
      return { version: 1, tabs, drafts, imageDrafts, videoDrafts, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null };
  } catch { return EMPTY_WORKSPACE; }
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Apply only this window's changed fields to the latest saved state. */
function mergeRecord<T extends object>(base: T | undefined, local: T, remote: T | undefined): T {
  const result = { ...(remote ?? local) } as T;
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(local)])) {
    const field = key as keyof T;
    if (equal(base?.[field], local[field])) continue;
    if (Object.hasOwn(local, field)) result[field] = local[field]; else delete result[field];
  }
  return result;
}

function mergeWorkspace(base: WorkspaceSnapshot, local: WorkspaceSnapshot, remote: WorkspaceSnapshot): WorkspaceSnapshot {
  const drafts = { ...remote.drafts };
  for (const id of new Set([...Object.keys(base.drafts), ...Object.keys(local.drafts)])) {
    if (equal(base.drafts[id], local.drafts[id])) continue;
    if (!Object.hasOwn(local.drafts, id)) delete drafts[id];
    else drafts[id] = mergeRecord(base.drafts[id], local.drafts[id], remote.drafts[id]);
  }
  const imageDrafts = { ...remote.imageDrafts };
  for (const id of new Set([...Object.keys(base.imageDrafts ?? {}), ...Object.keys(local.imageDrafts ?? {})])) {
    if (equal(base.imageDrafts?.[id], local.imageDrafts?.[id])) continue;
    if (!Object.hasOwn(local.imageDrafts ?? {}, id)) delete imageDrafts[id];
    else imageDrafts[id] = mergeRecord(base.imageDrafts?.[id], local.imageDrafts![id], remote.imageDrafts?.[id]);
  }
  const videoDrafts = { ...remote.videoDrafts };
  for (const id of new Set([...Object.keys(base.videoDrafts ?? {}), ...Object.keys(local.videoDrafts ?? {})])) {
    if (equal(base.videoDrafts?.[id], local.videoDrafts?.[id])) continue;
    if (!Object.hasOwn(local.videoDrafts ?? {}, id)) delete videoDrafts[id];
    else videoDrafts[id] = mergeRecord(base.videoDrafts?.[id], local.videoDrafts![id], remote.videoDrafts?.[id]);
  }
  const tabs = new Map(remote.tabs.map((tab) => [tab.id, tab]));
  const remoteKeys = new Map(remote.tabs.map((tab) => [tab.key, tab]));
  const baseIds = new Map(base.tabs.map((tab) => [tab.id, tab]));
  const localIds = new Set(local.tabs.map((tab) => tab.id));
  for (const previous of base.tabs) {
    // Eviction must not discard a pin or edit just saved by another window.
    if (!localIds.has(previous.id) && equal(previous, tabs.get(previous.id))) tabs.delete(previous.id);
  }
  for (const tab of local.tabs) {
    const previous = baseIds.get(tab.id);
    if (equal(previous, tab)) continue;
    const saved = tabs.get(tab.id) ?? remoteKeys.get(tab.key);
    const merged = mergeRecord(previous, tab, saved);
    merged.fields = mergeRecord(previous?.fields, tab.fields, saved?.fields);
    if (saved && saved.id !== tab.id) tabs.delete(saved.id);
    tabs.set(tab.id, merged);
  }
  const seen = new Set<string>();
  const uniqueTabs = [...tabs.values()].filter((tab) => {
    if (seen.has(tab.key)) return false;
    seen.add(tab.key); return true;
  });
  return { version: 1, drafts, imageDrafts, videoDrafts, tabs: uniqueTabs, activeId: uniqueTabs.some((tab) => tab.id === local.activeId) ? local.activeId : null };
}

/** Account-scoped, serializable workspace. No players, requests, or React trees live here. */
export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot = EMPTY_WORKSPACE;
  private persisted: WorkspaceSnapshot = EMPTY_WORKSPACE;
  private listeners = new Set<() => void>();
  private storage: WorkspaceStorage | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private storageFailure = false;
  private ready = false;
  private writerId = crypto.randomUUID();
  private sequence = 0;
  private flushRevision = 0;
  readonly storageKey: string;

  constructor(uid: string) { this.storageKey = `mdmedia.workspace.v1:${uid}`; }

  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isStorageUnavailable = (): boolean => this.storageFailure;
  isReady = (): boolean => this.ready;

  initialize(storage: WorkspaceStorage | null, href: string): void {
    this.restore(storage);
    this.visit(href);
    this.ready = true;
    this.emit();
  }

  restore(storage: WorkspaceStorage | null): void {
    this.storage = storage;
    try {
      const raw = storage?.getItem(this.storageKey) ?? null;
      this.snapshot = this.readSaved(raw);
      this.persisted = this.snapshot;
      this.emit();
    } catch { this.storageFailure = true; this.emit(); }
  }

  visit(href: string): WorkspaceTab | null {
    const route = workspaceRoute(href);
    if (!route) return null;
    const existing = this.snapshot.tabs.find((tab) => tab.key === route.key);
    if (existing && existing.href === route.href && this.snapshot.activeId === existing.id) return existing;
    const visitedAt = existing && this.snapshot.activeId === existing.id ? existing.visitedAt : Date.now();
    const tab = existing ? { ...existing, href: route.href, visitedAt } : { visitedAt, id: crypto.randomUUID(), key: route.key, href: route.href, title: route.title, scrollTop: 0, fields: {} };
    this.change({ ...this.snapshot, activeId: tab.id,
      tabs: existing ? this.snapshot.tabs.map((item) => item.id === tab.id ? tab : item) : [...this.snapshot.tabs, tab] });
    return tab;
  }

  open(href: string, title?: string): void {
    const route = workspaceRoute(href);
    if (!route) return;
    const existing = this.snapshot.tabs.find((tab) => tab.key === route.key);
    if (existing) { if (title) this.updateTab(existing.id, { title }); return; }
    this.change({ ...this.snapshot, tabs: [...this.snapshot.tabs, {
      id: crypto.randomUUID(), key: route.key, href: route.href, title: title || route.title, scrollTop: 0, fields: {},
    }] });
  }

  replaceTab(id: string, href: string, title?: string): void {
    const route = workspaceRoute(href);
    if (!route) return;
    this.change({ ...this.snapshot, tabs: this.snapshot.tabs
      .filter((tab) => tab.key !== route.key || tab.id === id)
      .map((tab) => tab.id === id ? { ...tab, key: route.key, href: route.href, title: title || route.title, scrollTop: 0 } : tab) });
  }

  updateTab(id: string, patch: Partial<Pick<WorkspaceTab, 'title' | 'scrollTop' | 'pinned'>>): void {
    const tab = this.snapshot.tabs.find((item) => item.id === id);
    if (!tab || Object.entries(patch).every(([key, value]) => tab[key as keyof WorkspaceTab] === value)) return;
    this.change({ ...this.snapshot, tabs: this.snapshot.tabs.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }

  togglePin(id: string): void {
    const view = this.snapshot.tabs.find((item) => item.id === id);
    if (view) this.updateTab(id, { pinned: !view.pinned });
  }

  close(id: string): string | null {
    const index = this.snapshot.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return null;
    const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id);
    const active = this.snapshot.activeId === id ? tabs[Math.min(index, tabs.length - 1)] : tabs.find((tab) => tab.id === this.snapshot.activeId);
    this.change({ ...this.snapshot, tabs, activeId: active?.id ?? null });
    return this.snapshot.activeId === active?.id && active ? active.href : '/library';
  }

  setDraft(id: string, patch: Partial<Draft>): void {
    this.change({ ...this.snapshot, drafts: { ...this.snapshot.drafts, [id]: { ...this.snapshot.drafts[id], ...patch } } });
  }

  setImageDraft(id: string, draft: ImageDraft): void {
    this.change({ ...this.snapshot, imageDrafts: { ...this.snapshot.imageDrafts, [id]: draft } });
  }
  clearImageDraft(id: string): void {
    const imageDrafts = { ...this.snapshot.imageDrafts }; delete imageDrafts[id];
    this.change({ ...this.snapshot, imageDrafts });
  }

  setVideoDraft(id: string, draft: VideoDraft): void {
    this.change({ ...this.snapshot, videoDrafts: { ...this.snapshot.videoDrafts, [id]: draft } });
  }
  clearVideoDraft(id: string): void {
    const videoDrafts = { ...this.snapshot.videoDrafts }; delete videoDrafts[id];
    this.change({ ...this.snapshot, videoDrafts });
  }

  clearDraft(id: string): void {
    const drafts = { ...this.snapshot.drafts };
    delete drafts[id];
    this.change({ ...this.snapshot, drafts });
  }

  setField(id: string, name: string, value: string | boolean | number | null): void {
    const tab = this.snapshot.tabs.find((item) => item.id === id);
    if (!tab || tab.fields[name] === value) return;
    this.change({ ...this.snapshot, tabs: this.snapshot.tabs.map((item) => item.id === id ? { ...item, fields: { ...item.fields, [name]: value } } : item) });
  }

  /** Only clear the acknowledged edit, never text entered while its save was pending. */
  acknowledgeField(id: string, name: string, saved: string): void {
    if (this.snapshot.tabs.find((tab) => tab.id === id)?.fields[name] === saved) this.setField(id, name, null);
  }

  /** Storage events update saved work without discarding this window's pending edits. */
  reconcile = (): void => {
    if (!this.storage) return;
    try {
      const remote = this.readSaved(this.storage.getItem(this.storageKey));
      this.snapshot = mergeWorkspace(this.persisted, this.snapshot, remote);
      this.persisted = remote;
      this.emit();
    } catch { this.storageFailure = true; this.emit(); }
  };

  /** Journal synchronously before waiting for a cross-window lock, including on pagehide. */
  flush = (): void | Promise<void> => {
    clearTimeout(this.timer);
    const revision = ++this.flushRevision;
    const storage = this.storage;
    if (!storage) { this.storageFailure = true; this.emit(); return; }
    const queued = this.snapshot;
    try {
      if (storage.keys && storage.removeItem) {
        const sequence = ++this.sequence;
        storage.setItem(`${this.storageKey}:pending:${this.writerId}:${sequence}`, JSON.stringify({
          base: this.persisted, snapshot: queued, created: Date.now(), sequence, writer: this.writerId,
        }));
      }
      const commit = () => {
        try {
          const keys = storage.keys?.().filter((key) => key.startsWith(`${this.storageKey}:pending:`)) ?? [];
          const merged = this.readSaved(storage.getItem(this.storageKey), keys);
          // Stores without journals are synchronous single-window test adapters.
          const saved = storage.keys ? merged : mergeWorkspace(this.persisted, this.snapshot, merged);
          storage.setItem(this.storageKey, JSON.stringify(saved));
          // A new journal written while this commit runs has a unique key and remains recoverable.
          for (const key of keys) storage.removeItem?.(key);
          this.snapshot = mergeWorkspace(queued, this.snapshot, saved);
          this.persisted = saved;
          if (revision === this.flushRevision) this.storageFailure = false;
        } catch { if (revision === this.flushRevision) this.storageFailure = true; }
        this.emit();
      };
      if (storage.exclusive) return storage.exclusive(commit).catch(() => { if (revision === this.flushRevision) this.storageFailure = true; this.emit(); });
      commit();
    } catch { this.storageFailure = true; this.emit(); }
  };

  private readSaved(raw: string | null, keys?: string[]): WorkspaceSnapshot {
    let saved = readSnapshot(raw);
    const journals = (keys ?? this.storage?.keys?.() ?? [])
      .filter((key) => key.startsWith(`${this.storageKey}:pending:`))
      .flatMap((key) => {
        try {
          const record = JSON.parse(this.storage?.getItem(key) ?? "null");
          if (record?.base?.version !== 1 || !Array.isArray(record.base.tabs) || record.snapshot?.version !== 1 || !Array.isArray(record.snapshot.tabs) || !Number.isFinite(record.created) || !Number.isFinite(record.sequence) || typeof record.writer !== "string") return [];
          return [record];
        } catch { return []; }
      }).sort((a, b) => a.created - b.created || a.sequence - b.sequence || a.writer.localeCompare(b.writer));
    for (const record of journals) saved = mergeWorkspace(readSnapshot(JSON.stringify(record.base)), readSnapshot(JSON.stringify(record.snapshot)), saved);
    return saved;
  }

  dispose(): void { this.flush(); this.listeners.clear(); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private change(snapshot: WorkspaceSnapshot): void {
    const recentIds = new Set(snapshot.tabs.filter((view) => !view.pinned)
      .sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0)).slice(0, 100).map((view) => view.id));
    this.snapshot = { ...snapshot, tabs: snapshot.tabs.filter((view) => view.id === snapshot.activeId || view.pinned || recentIds.has(view.id)
      || Object.values(view.fields).some((value) => value !== null && value !== '')) };
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, 250);
  }
}
