"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useConnectivity } from "@/lib/connectivity";
import { EMPTY_WORKSPACE, WorkspaceStore, workspaceRoute, type WorkspaceSnapshot, type WorkspaceStorage, type WorkspaceTab } from "@/lib/workspace";

interface WorkspaceContextValue {
  store: WorkspaceStore;
  state: WorkspaceSnapshot;
  activeTab: WorkspaceTab | undefined;
  draftId: string;
  storageUnavailable: boolean;
  selectTab: (tab: WorkspaceTab) => void;
  closeTab: (id: string) => void;
  newDraft: () => void;
  replaceCurrent: (href: string, title?: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** One normal Next route is active. Inactive tabs retain data, never mounted page trees. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const offline = useConnectivity() === "offline";
  const pathname = usePathname();
  const search = useSearchParams();
  const href = `${pathname}${search.size ? `?${search.toString()}` : ""}`;
  const [store] = useState(() => new WorkspaceStore(user!.uid));
  const ready = useSyncExternalStore(store.subscribe, store.isReady, () => false);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_WORKSPACE);
  const storageUnavailable = useSyncExternalStore(store.subscribe, store.isStorageUnavailable, () => false);

  useEffect(() => {
    let storage: WorkspaceStorage | null = null;
    try {
      const browserStorage = window.localStorage;
      storage = {
        getItem: (key) => browserStorage.getItem(key),
        setItem: (key, value) => {
          if (!navigator.locks) throw new Error("Workspace saving requires browser Web Locks");
          browserStorage.setItem(key, value);
        },
        removeItem: (key) => browserStorage.removeItem(key),
        keys: () => Array.from({ length: browserStorage.length }, (_, index) => browserStorage.key(index)).filter((key): key is string => key !== null),
        exclusive: (commit) => navigator.locks.request(store.storageKey, commit),
      };
    } catch { /* Work continues in memory. */ }
    store.initialize(storage, `${window.location.pathname}${window.location.search}${window.location.hash}`);
    const visit = () => store.visit(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    const flush = () => store.flush();
    const synchronize = (event: StorageEvent) => {
      if (event.key !== store.storageKey && !event.key?.startsWith(`${store.storageKey}:pending:`)) return;
      store.reconcile();
      visit();
    };
    window.addEventListener("storage", synchronize);
    window.addEventListener("popstate", visit);
    window.addEventListener("hashchange", visit);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener("popstate", visit);
      window.removeEventListener("hashchange", visit);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      store.dispose();
    };
  }, [store]);

  useEffect(() => { if (ready) store.visit(href + window.location.hash); }, [href, ready, store]);

  const selectTab = useCallback((tab: WorkspaceTab) => {
    // Existing routes, links, redirects, and browser history all use the same router.
    const url = new URL(tab.href, window.location.origin);
    if (offline && url.pathname !== "/downloads") return;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === tab.href) return;
    if (url.pathname === window.location.pathname) window.history.pushState(null, "", tab.href);
    else if (offline) window.location.assign(tab.href);
    else router.push(tab.href, { scroll: false });
  }, [router, offline]);
  const closeTab = useCallback((id: string) => {
    const active = store.getSnapshot().activeId === id;
    const documents=store.getSnapshot().tabs.filter(tab=>/^\/(studio(?:\?|$|\/scene)|narration\/)/.test(tab.href));
    const index=documents.findIndex(tab=>tab.id===id);
    const remaining=documents.filter(tab=>tab.id!==id);
    const closed=store.close(id);
    const next=index>=0?remaining[Math.min(index,remaining.length-1)]?.href??'/projects':closed;
    store.flush();
    if (active && next) {
      const target = offline ? store.getSnapshot().tabs.find((tab) => new URL(tab.href, window.location.origin).pathname === "/downloads")?.href ?? "/downloads" : next;
      store.visit(target);
      if (new URL(target, window.location.origin).pathname === window.location.pathname) window.history.replaceState(null, "", target);
      else if (offline) window.location.assign(target);
      else router.replace(target, { scroll: false });
    }
  }, [router, store, offline]);
  const newDraft = useCallback(() => router.push(`${pathname === '/studio/scene' ? '/studio/scene' : '/studio'}?draft=${crypto.randomUUID()}`), [router, pathname]);
  const replaceCurrent = useCallback((next: string, title?: string) => {
    const id = store.getSnapshot().activeId;
    if (id) store.replaceTab(id, next, title);
    router.push(next, { scroll: false });
  }, [router, store]);

  const route = workspaceRoute(href);
  const activeTab = state.tabs.find((tab) => tab.key === route?.key);
  const value = useMemo(() => ({ store, state, activeTab, draftId: route?.draftId ?? "default",
    storageUnavailable, selectTab, closeTab, newDraft, replaceCurrent }),
    [store, state, activeTab, route?.draftId, storageUnavailable, selectTab, closeTab, newDraft, replaceCurrent]);

  if (!ready) return <div className="grid h-dvh place-items-center"><Loader2 size={20} className="animate-spin" /><span className="sr-only">Restoring workspace</span></div>;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}

export function useOptionalWorkspace(): WorkspaceContextValue | null { return useContext(WorkspaceContext); }

/** Shareable view state goes in the URL; replacing it does not create another tab/history entry. */
export function useRouteQuery(name: string): [string, (value: string) => void] {
  const search = useSearchParams();
  const value = search.get(name) ?? "";
  const setValue = useCallback((next: string) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set(name, next); else url.searchParams.delete(name);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [name]);
  return [value, setValue];
}

/** Unfinished form edits belong to their route tab, rather than its mounted component. */
type Widen<T> = T extends string ? string : T extends boolean ? boolean : T extends number ? number : T;
export function useWorkspaceField<T extends string | boolean | number | null>(name: string, initial: T): [Widen<T>, (value: Widen<T>) => void] {
  const { activeTab, store } = useWorkspace();
  const stored = activeTab?.fields[name];
  const compatible = stored !== undefined && (typeof stored === typeof initial || initial === null && (stored === null || typeof stored === "string"));
  const value = (compatible ? stored : initial) as Widen<T>;
  const setValue = useCallback((next: Widen<T>) => { if (activeTab) store.setField(activeTab.id, name, next); }, [activeTab, store, name]);
  return [value, setValue];
}
