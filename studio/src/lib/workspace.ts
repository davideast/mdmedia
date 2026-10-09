import {readScriptPlacement} from './script-timeline';
import {readVideoScript,readVideoBrief} from './video-script';
import {readAudioPlacements} from './audio-placement';
import type { Draft } from '../components/shell/narration-provider';
import { readSceneDraft } from './scene-direction';
import { isVideoId, type SceneDraftRecord, type SceneBeatClip } from './video-generation';

export interface WorkspaceTab {
  id: string;
  key: string;
  href: string;
  title: string;
  scrollTop: number;
  fields: Record<string, string | boolean | number | null>;
}

export interface WorkspaceProject { id:string; name:string; documents:Record<string,string> }
export interface WorkspaceSnapshot {
  projects?:Record<string,WorkspaceProject>;
  version: 1;
  tabs: WorkspaceTab[];
  activeId: string | null;
  drafts: Record<string, Partial<Draft>>;
  sceneDrafts: Record<string, SceneDraftRecord>;
}

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  keys?: () => string[];
  removeItem?: (key: string) => void;
  exclusive?: (commit: () => void) => Promise<void>;
}

const ORIGIN = 'https://workspace.local';
export const EMPTY_WORKSPACE: WorkspaceSnapshot = { version: 1, tabs: [], activeId: null, drafts: {}, sceneDrafts: {} };
const PAGE_TITLES: Record<string, string> = {
  '/studio': 'Draft', '/library': 'Library', '/queue': 'Activity',
  '/playlists': 'Playlists', '/downloads': 'Downloads', '/settings': 'Settings',
  '/studio/scene': 'Video', '/projects':'Projects',
};

/** URLs identify views. A tab's key identifies the item even when its view/query changes. */
export function workspaceRoute(href: string): { href: string; key: string; title: string; draftId?: string } | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || url.pathname === '/' || /^\/(api|_next)(\/|$)/.test(url.pathname)) return null;
  const path = url.pathname.replace(/\/$/, '');
  const draftId = path === '/studio' || path === '/studio/scene' ? url.searchParams.get('draft') || 'default' : undefined;
  const entity = draftId ?? url.searchParams.get('playlist') ?? url.searchParams.get('track');
  return {
    href: `${path}${url.search}${url.hash}`,
    key: entity ? `${path}:${entity}` : path,
    title: PAGE_TITLES[path] ?? (path.startsWith('/narration/') ? 'Narration' : path.startsWith('/profile/') ? 'Profile' : path.split('/').pop() || 'Page'),
    draftId,
  };
}

function readDraft(value: unknown): Partial<Draft> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const draft: Partial<Draft> = {};
  for (const field of ['markdown', 'promptStyle', 'rewriteInstructions'] as const) {
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
      for (const tab of saved.tabs) {
        if (typeof tab?.href !== 'string' || typeof tab.id !== 'string') continue;
        const route = workspaceRoute(tab.href);
        if (!route || tabs.some((item) => item.key === route.key || item.id === tab.id)) continue;
        tabs.push({ id: tab.id, key: route.key, href: route.href,
          title: typeof tab.title === 'string' ? tab.title.slice(0, 200) : route.title,
          scrollTop: typeof tab.scrollTop === 'number' && Number.isFinite(tab.scrollTop) ? Math.max(0, tab.scrollTop) : 0,
          fields: Object.fromEntries(Object.entries(tab.fields && typeof tab.fields === 'object' ? tab.fields : {})
            .filter(([, value]) => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) as WorkspaceTab['fields'] });
      }
      const drafts: Record<string, Partial<Draft>> = Object.create(null);
      if (saved.drafts && typeof saved.drafts === 'object') {
        for (const [id, draft] of Object.entries(saved.drafts)) drafts[id] = readDraft(draft);
      }
      const sceneDrafts: Record<string, SceneDraftRecord> = Object.create(null);
      for (const [id, record] of Object.entries(saved.sceneDrafts ?? {})) {
        if (!record || typeof record !== 'object' || !('draft' in record)) continue;
        const draft = readSceneDraft({ version: 1, draft: record.draft });
        if (!draft) continue;
        const beatClips: Record<string, SceneBeatClip> = Object.create(null);
        if ('beatClips' in record && record.beatClips && typeof record.beatClips === 'object') {
          for (const [beatId, clip] of Object.entries(record.beatClips)) {
            if (!clip || typeof clip !== 'object' || !draft.beats.some(beat => beat.id === beatId)) continue;
            const value = clip as Partial<SceneBeatClip>;
            beatClips[beatId] = {
              ...(readScriptPlacement(value.placement)?{placement:readScriptPlacement(value.placement)}:{}),
              ...(isVideoId(value.pendingVideoId??'')?{pendingVideoId:value.pendingVideoId}:{}),
              ...(value.timingAccepted?{timingAccepted:true}:{}),
              ...(Array.isArray(value.takeHistory)?{takeHistory:value.takeHistory.filter(take=>take&&isVideoId(take.videoId)&&[take.inSeconds,take.outSeconds].every(value=>value===undefined||typeof value==='number'&&Number.isFinite(value)&&value>=0)).slice(-20)}:{}),
              ...(typeof value.videoId === 'string' && isVideoId(value.videoId) ? {videoId:value.videoId} : {}),
              ...(typeof value.inSeconds === 'number' && Number.isFinite(value.inSeconds) && value.inSeconds >= 0 ? {inSeconds:value.inSeconds} : {}),
              ...(typeof value.outSeconds === 'number' && Number.isFinite(value.outSeconds) && value.outSeconds > 0 ? {outSeconds:value.outSeconds} : {}),
              muted:value.muted === true, excluded:value.excluded === true,
              ...(value.generationMode==='continue'?{generationMode:'continue' as const}:{}),
              ...(value.transition==='fade'?{transition:'fade' as const}:{}),
              ...(typeof value.transitionSeconds==='number'&&Number.isFinite(value.transitionSeconds)&&value.transitionSeconds>0?{transitionSeconds:value.transitionSeconds}:{}),
            };
          }
        }
        sceneDrafts[id] = { draft,...(readVideoScript((record as Record<string,unknown>).builtScript)?{builtScript:readVideoScript((record as Record<string,unknown>).builtScript)!}:{}),...(readVideoBrief((record as Record<string,unknown>).videoBrief)?{videoBrief:readVideoBrief((record as Record<string,unknown>).videoBrief)!}:{}),...('title' in record&&typeof record.title==='string'?{title:record.title.slice(0,100)}:{}),...((record as Record<string,unknown>).audioPlacements?{audioPlacements:readAudioPlacements((record as Record<string,unknown>).audioPlacements)}:{}), ...(Object.keys(beatClips).length ? {beatClips}:{}),
          ...('videoId' in record && typeof record.videoId === 'string' && isVideoId(record.videoId) ? { videoId: record.videoId } : {}),
          ...('exportId' in record && typeof record.exportId === 'string' && isVideoId(record.exportId) ? { exportId: record.exportId } : {}),
          ...('view' in record && record.view === 'tracks' ? {view:'tracks' as const} : {}),
        };
      }
      const projects:Record<string,WorkspaceProject>={};
      for(const [id,value] of Object.entries(saved.projects??{})){
        if(!value||typeof value!=='object')continue;
        const item=value as Record<string,unknown>;
        if(typeof item.name!=='string')continue;
        const documents:Record<string,string>={};
        for(const [href,title] of Object.entries(item.documents&&typeof item.documents==='object'?item.documents:{}))if(workspaceRoute(href)&&typeof title==='string')documents[href]=title.slice(0,200);
        projects[id]={id,name:item.name.slice(0,100),documents};
      }
      return { version: 1, tabs, drafts, sceneDrafts,...(Object.keys(projects).length?{projects}:{}), activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null };
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
  const projects={...remote.projects};
  for(const [id,project] of Object.entries(local.projects??{}))if(!equal(base.projects?.[id],project))projects[id]={...mergeRecord(base.projects?.[id],project,projects[id]),documents:mergeRecord(base.projects?.[id]?.documents,project.documents,projects[id]?.documents)};
  const sceneDrafts = { ...remote.sceneDrafts };
  for (const id of new Set([...Object.keys(base.sceneDrafts), ...Object.keys(local.sceneDrafts)])) {
    if (equal(base.sceneDrafts[id], local.sceneDrafts[id])) continue;
    if (!Object.hasOwn(local.sceneDrafts, id)) delete sceneDrafts[id];
    else {
      const merged = mergeRecord(base.sceneDrafts[id], local.sceneDrafts[id], remote.sceneDrafts[id]);
      const beats = { ...remote.sceneDrafts[id]?.beatClips };
      for (const beatId of new Set([...Object.keys(base.sceneDrafts[id]?.beatClips ?? {}), ...Object.keys(local.sceneDrafts[id]?.beatClips ?? {})])) {
        const before = base.sceneDrafts[id]?.beatClips?.[beatId]; const next = local.sceneDrafts[id]?.beatClips?.[beatId];
        if (equal(before,next)) continue;
        if (!next) delete beats[beatId]; else beats[beatId] = mergeRecord(before,next,beats[beatId]);
      }
      sceneDrafts[id] = {...merged,...(Object.keys(beats).length ? {beatClips:beats}:{})};
    }
  }
  const drafts = { ...remote.drafts };
  for (const id of new Set([...Object.keys(base.drafts), ...Object.keys(local.drafts)])) {
    if (equal(base.drafts[id], local.drafts[id])) continue;
    if (!Object.hasOwn(local.drafts, id)) delete drafts[id];
    else drafts[id] = mergeRecord(base.drafts[id], local.drafts[id], remote.drafts[id]);
  }
  const tabs = new Map(remote.tabs.map((tab) => [tab.id, tab]));
  for (const previous of base.tabs) {
    if (!local.tabs.some((tab) => tab.id === previous.id)) tabs.delete(previous.id);
  }
  for (const tab of local.tabs) {
    const previous = base.tabs.find((item) => item.id === tab.id);
    if (equal(previous, tab)) continue;
    const saved = tabs.get(tab.id) ?? remote.tabs.find((item) => item.key === tab.key);
    const merged = mergeRecord(previous, tab, saved);
    merged.fields = mergeRecord(previous?.fields, tab.fields, saved?.fields);
    if (saved && saved.id !== tab.id) tabs.delete(saved.id);
    tabs.set(tab.id, merged);
  }
  const uniqueTabs = [...tabs.values()].filter((tab, index, items) => items.findIndex((item) => item.key === tab.key) === index);
  return { version: 1, drafts, sceneDrafts,...(Object.keys(projects).length?{projects}:{}), tabs: uniqueTabs, activeId: uniqueTabs.some((tab) => tab.id === local.activeId) ? local.activeId : null };
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
    const tab = existing ? { ...existing, href: route.href } : { id: crypto.randomUUID(), key: route.key, href: route.href, title: route.title, scrollTop: 0, fields: {} };
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
    const previous=this.snapshot.tabs.find(tab=>tab.id===id);
    const projects={...this.snapshot.projects};
    if(previous)for(const [projectId,project] of Object.entries(projects))if(project.documents[previous.href]){
      const documents={...project.documents};delete documents[previous.href];documents[route.href]=title||previous.title;projects[projectId]={...project,documents};
    }
    this.change({ ...this.snapshot,...(Object.keys(projects).length?{projects}:{}), tabs: this.snapshot.tabs
      .filter((tab) => tab.key !== route.key || tab.id === id)
      .map((tab) => tab.id === id ? { ...tab, key: route.key, href: route.href, title: title || route.title, scrollTop: 0 } : tab) });
  }

  updateTab(id: string, patch: Partial<Pick<WorkspaceTab, 'title' | 'scrollTop'>>): void {
    const tab = this.snapshot.tabs.find((item) => item.id === id);
    if (!tab || Object.entries(patch).every(([key, value]) => tab[key as keyof WorkspaceTab] === value)) return;
    this.change({ ...this.snapshot, tabs: this.snapshot.tabs.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }

  close(id: string): string | null {
    const index = this.snapshot.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return null;
    const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id);
    const active = this.snapshot.activeId === id ? tabs[Math.min(index, tabs.length - 1)] : tabs.find((tab) => tab.id === this.snapshot.activeId);
    this.change({ ...this.snapshot, tabs, activeId: active?.id ?? null });
    return this.snapshot.activeId === active?.id && active ? active.href : '/library';
  }

  setProject(project:WorkspaceProject):void {
    this.change({...this.snapshot,projects:{...this.snapshot.projects,[project.id]:project}});
  }

  setDraft(id: string, patch: Partial<Draft>): void {
    this.change({ ...this.snapshot, drafts: { ...this.snapshot.drafts, [id]: { ...this.snapshot.drafts[id], ...patch } } });
  }

  setSceneDraft(id: string, record: SceneDraftRecord): void {
    this.change({ ...this.snapshot, sceneDrafts: { ...this.snapshot.sceneDrafts, [id]: record } });
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
    this.snapshot = snapshot;
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, 250);
  }
}
