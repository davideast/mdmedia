"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, BookOpen, Check, ChevronDown, Download, FileText, Library, ListMusic, ListOrdered, Loader2, Plus, Settings, UserRound, Volume2, WifiOff, X, CircleAlert } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useWorkspace } from "./workspace-provider";
import { useNarration } from "./narration-provider";
import { useOfflinePlayback } from "./offline-playback-provider";
import { useConnectivity } from "@/lib/connectivity";
import type { WorkspaceTab } from "@/lib/workspace";
import { watchMyNarrations } from "@/lib/narrations";
import { useAuth } from "@/lib/auth-context";
import type { Narration } from "@/lib/types";

function itemIcon(href: string) {
  const path = href.split("?")[0];
  if (path.startsWith("/narration/")) return BookOpen;
  if (path === "/studio") return FileText;
  if (path === "/library") return Library;
  if (path === "/playlists") return ListMusic;
  if (path === "/downloads") return Download;
  if (path === "/queue") return ListOrdered;
  if (path === "/settings") return Settings;
  if (path.startsWith("/profile/")) return UserRound;
  return AudioLines;
}

export function WorkspaceTabs() {
  const { state, activeTab, store, selectTab, closeTab, newDraft, storageUnavailable } = useWorkspace();
  const { stream, queue, generationQueue } = useNarration();
  const downloads = useOfflinePlayback();
  const uid = useAuth().user?.uid ?? null;
  const offline = useConnectivity() === "offline";
  const seenJobs = useRef(new Set<string>());
  const focusAfterClose = useRef(false);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const [serverStatus, setServerStatus] = useState<Record<string, Narration["status"]>>({});
  const watchedIds = JSON.stringify(state.tabs.map((tab) => new URL(tab.href, "https://workspace.local").pathname)
    .filter((path) => path.startsWith("/narration/")).map((path) => path.split("/")[2]).sort());

  // One shared query of the person's own narrations keeps every narration tab's
  // status and title current. A listener per tab grew with the tab count and
  // replayed denials for tabs whose narration had since been deleted.
  useEffect(() => {
    if (offline || !uid || watchedIds === "[]") return;
    const ids = new Set(JSON.parse(watchedIds) as string[]);
    let active = true;
    const stop = watchMyNarrations(uid, (narrations) => {
      if (!active) return;
      const tabs = store.getSnapshot().tabs;
      setServerStatus((previous) => {
        const next: Record<string, Narration["status"]> = {};
        for (const narration of narrations) if (ids.has(narration.id)) next[narration.id] = narration.status;
        const keys = Object.keys(next);
        return keys.length === Object.keys(previous).length && keys.every((id) => previous[id] === next[id]) ? previous : next;
      });
      for (const narration of narrations) {
        if (!ids.has(narration.id) || !narration.title) continue;
        const tab = tabs.find((item) => item.key === `/narration/${narration.id}`);
        if (tab && tab.title !== narration.title) store.updateTab(tab.id, { title: narration.title });
      }
    });
    return () => { active = false; stop(); };
  }, [offline, uid, watchedIds, store]);

  useEffect(() => {
    for (const job of generationQueue.jobs) {
      if (!job.narrationId) continue;
      const href = `/narration/${job.narrationId}`;
      const existing = store.getSnapshot().tabs.find((tab) => tab.key === href);
      if (!seenJobs.current.has(job.id)) { store.open(href, job.title); seenJobs.current.add(job.id); }
      else if (existing && job.status !== "ready") store.updateTab(existing.id, { title: job.title });
    }
  }, [generationQueue.jobs, store]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusAfterClose.current && selectedRef.current) {
      selectedRef.current.focus();
      focusAfterClose.current = false;
    }
  }, [activeTab?.id]);
  const close = (id: string) => {
    focusAfterClose.current = activeTab?.id === id;
    closeTab(id);
  };
  const selectableTabs = state.tabs.filter((tab) => !offline || new URL(tab.href, "https://workspace.local").pathname === "/downloads");

  const status = (tab: WorkspaceTab) => {
    const url = new URL(tab.href, "https://workspace.local");
    const narrationId = url.pathname.startsWith("/narration/") ? url.pathname.split("/")[2] : null;
    const job = generationQueue.jobs.find((item) => item.narrationId === narrationId);
    const playing = stream.playing && (stream.id === narrationId || (url.pathname === "/playlists" && url.searchParams.get("playlist") === queue?.playlistId))
      || downloads.playing && url.pathname === "/downloads" && (url.searchParams.get("track") ? url.searchParams.get("track") === downloads.track?.id
        : url.searchParams.get("playlist") ? url.searchParams.get("playlist") === downloads.playlistId : true);
    if (playing) return { Icon: Volume2, text: "Playing", className: "text-primary" };
    if (job?.status === "error") return { Icon: CircleAlert, text: "Failed", className: "text-destructive" };
    if (job && ["queued", "starting", "streaming"].includes(job.status)) return { Icon: Loader2,
      text: job.totalChunks ? `${job.completedChunks}/${job.totalChunks}` : job.status === "queued" ? "Queued" : "Generating",
      className: "animate-spin text-primary" };
    if (offline && url.pathname !== "/downloads") return { Icon: WifiOff, text: "Requires connection", className: "text-ink-muted" };
    if (narrationId && serverStatus[narrationId] === "streaming") return { Icon: Loader2, text: "Generating", className: "animate-spin text-primary" };
    if (narrationId && serverStatus[narrationId] === "error") return { Icon: CircleAlert, text: "Failed", className: "text-destructive" };
    if (job?.status === "ready" || narrationId && serverStatus[narrationId] === "ready") return { Icon: Check, text: "Ready", className: "text-primary" };
    return { Icon: itemIcon(tab.href), text: url.pathname === "/studio" ? "Draft" : "", className: "text-ink-muted" };
  };

  return (
    <div className="flex min-w-0 flex-none items-center border-b border-border bg-surface-inset">
      <div role="tablist" aria-label="Open workspace pages" className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {state.tabs.map((tab) => {
          const selected = activeTab?.id === tab.id;
          const { Icon, text, className } = status(tab);
          const label = `${tab.title}${text ? ` — ${text}` : ""}`;
          const disabled = offline && new URL(tab.href, "https://workspace.local").pathname !== "/downloads";
          return <div key={tab.id} className={`group flex h-11 max-w-64 flex-none items-center border-r border-border ${selected ? "bg-background shadow-[inset_0_-2px_0_var(--primary)]" : "hover:bg-muted"}`}>
            <button type="button" role="tab" id={`workspace-tab-${tab.id}`} aria-selected={selected} aria-controls="workspace-page"
              ref={selected ? selectedRef : undefined} tabIndex={selected ? 0 : -1} title={label} aria-label={label} disabled={disabled}
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => {
                const index = selectableTabs.indexOf(tab);
                const next = event.key === "ArrowRight" ? selectableTabs[(index + 1) % selectableTabs.length]
                  : event.key === "ArrowLeft" ? selectableTabs[(index - 1 + selectableTabs.length) % selectableTabs.length]
                  : event.key === "Home" ? selectableTabs[0] : event.key === "End" ? selectableTabs.at(-1) : undefined;
                if (next) { event.preventDefault(); selectTab(next); document.getElementById(`workspace-tab-${next.id}`)?.focus(); }
                if (event.key === "Delete") { event.preventDefault(); close(tab.id); }
              }}
              className="flex h-full min-w-0 items-center gap-2 px-3 text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50">
              <Icon size={14} className={`flex-none ${className}`} /><span className="truncate">{tab.title}</span>
              {text && text !== "Draft" ? <span className="hidden flex-none text-[10px] text-ink-muted sm:inline">{text}</span> : null}
            </button>
            <button type="button" onClick={() => close(tab.id)} aria-label={`Close ${tab.title} tab`} title="Close tab; keeps saved work and playback"
              className="mr-1 inline-flex size-8 flex-none items-center justify-center rounded text-ink-muted hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X size={12} /></button>
          </div>;
        })}
      </div>
      <Select value={activeTab?.id ?? ""} onValueChange={(id) => { const tab = state.tabs.find((item) => item.id === id); if (tab) selectTab(tab); }}>
        <SelectTrigger aria-label={`Switch open page (${state.tabs.length})`} title="All open pages" className="h-9 w-10 flex-none border-0 bg-transparent px-2 [&>svg:last-child]:hidden"><ChevronDown size={16} /></SelectTrigger>
        <SelectContent>{state.tabs.map((tab) => <SelectItem key={tab.id} value={tab.id} disabled={offline && new URL(tab.href, "https://workspace.local").pathname !== "/downloads"}>{tab.title} · {status(tab).text || "Open"}</SelectItem>)}</SelectContent>
      </Select>
      <button type="button" onClick={newDraft} disabled={offline} aria-label="New narration draft" title={offline ? "Requires Studio connection" : "New narration draft"}
        className="mx-1 inline-flex size-9 flex-none items-center justify-center rounded text-ink-muted hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"><Plus size={16} /></button>
      {storageUnavailable ? <span role="status" className="px-2 text-xs text-destructive" title="Browser storage is unavailable. Work is only kept until this page closes.">Not saved on device</span> : null}
    </div>
  );
}
