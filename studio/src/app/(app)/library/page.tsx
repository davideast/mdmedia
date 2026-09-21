"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Library, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useAuth } from "@/lib/auth-context";
import { watchMyNarrations } from "@/lib/narrations";
import type { Narration } from "@/lib/types";

const READABLE_VISIBILITY: Record<Narration["visibility"], string> = {
  private: "Only you",
  shared: "Shared",
  public: "Public",
};

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function LibraryPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Narration[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (user === null) return;
    return watchMyNarrations(user.uid, setItems);
  }, [user]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.transcript.toLowerCase().includes(needle),
    );
  }, [items, query]);

  return (
    <WorkbenchPanel
      title="Library"
      icon={<Library size={13} strokeWidth={2} />}
      bodyClassName="gap-0 p-0"
    >
      <div className="grid gap-5 p-6">
        <div className="relative">
          <Search
            size={15}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your narrations"
            className="h-10 rounded-full pl-9"
          />
        </div>

        {/* Height is locked so typing in the field above never moves anything. */}
        <div className="grid h-[calc(100dvh-14rem)] content-start gap-3 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="t-lead pt-8">
              {items.length === 0
                ? "Nothing here yet. Anything you narrate will be waiting for you."
                : "No narration matches that."}
            </p>
          ) : (
            /* Three explicit rows on the list, and each card spans all three as a
               subgrid — so titles, excerpts and footers lock to the same
               horizontal planes across a row no matter how long the excerpt is. */
            <ul className="grid auto-rows-[auto_1fr_auto] gap-3 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
              {filtered.map((item) => (
                <li key={item.id} className="grid grid-rows-subgrid row-span-3">
                  <Link
                    href={`/narration/${item.id}`}
                    className="grid grid-rows-subgrid row-span-3 gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted"
                  >
                    <span className="t-card-title truncate">{item.title}</span>
                    <span className="t-card-desc line-clamp-2">
                      {item.transcript.slice(0, 160)}
                    </span>
                    <span className="t-mono flex items-center justify-between tabular-nums">
                      <span>{READABLE_VISIBILITY[item.visibility]}</span>
                      <span>{duration(item.durationMs)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </WorkbenchPanel>
  );
}
