"use client";

import { useEffect, useRef, type JSX } from "react";
import { cn } from "cn";
import { referenceKindLabel } from "@/lib/chat/references";
import type {
  ChatEntityReference,
  ChatReferenceKind,
} from "@/lib/chat/types";
import { CutStatusIndicator, ReferenceLeadVisual } from "./chat-reference-chip";

export interface ChatReferencePopoverProps {
  items: readonly ChatEntityReference[];
  loading: boolean;
  kindFilter: ChatReferenceKind | null;
  selectedIndex: number;
  onHoverIndex: (index: number) => void;
  onSelect: (reference: ChatEntityReference) => void;
}

const REDUNDANT_META_BADGES = new Set([
  "img",
  "image",
  "video",
  "music",
  "sfx",
  "narration",
  "analysis",
  "doc",
  "document",
  "tree",
  "prod",
  "production",
  "cut",
  "sb",
  "storyboard",
  "character",
  "prop",
  "playlist",
]);

function formatRowMeta(item: ChatEntityReference): string {
  const kindText =
    item.kind === "tree-doc"
      ? "Document"
      : item.kind === "analysis"
        ? "Analysis"
        : item.kind === "character" && item.characterKind === "thing"
          ? "Prop"
          : referenceKindLabel(item.kind, item.characterKind);

  if (item.isLocalDraft) {
    return `${kindText} · Draft`;
  }

  if (item.kind === "character") {
    return item.subId ? `${kindText} · v${item.subId}` : kindText;
  }

  const rawMeta = item.metaLabel?.trim();
  if (!rawMeta) return kindText;

  const cleanedMeta = rawMeta.replace(/^sfx\s*·\s*/i, "").trim();
  if (!cleanedMeta || REDUNDANT_META_BADGES.has(cleanedMeta.toLowerCase())) {
    return kindText;
  }

  return `${kindText} · ${cleanedMeta}`;
}

function emptyLabelForKind(kind: ChatReferenceKind | null): string {
  if (!kind) return "No matching Studio items.";
  switch (kind) {
    case "character":
      return "No matching characters.";
    case "storyboard":
      return "No matching storyboards.";
    case "production":
      return "No matching productions.";
    case "cut":
      return "No matching cuts.";
    case "tree":
    case "tree-doc":
      return "No matching documents.";
    case "playlist":
      return "No matching playlists.";
    case "sfx":
      return "No matching sound effects.";
    case "analysis":
      return "No matching analyses.";
    default:
      return `No matching ${kind}s.`;
  }
}

export function ChatReferencePopover({
  items,
  loading,
  kindFilter,
  selectedIndex,
  onHoverIndex,
  onSelect,
}: ChatReferencePopoverProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>(
      `[data-ref-index="${selectedIndex}"]`,
    );
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, items.length]);

  // Never flash an empty loading box while initial catalog items are resolving.
  if (loading && items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-30 px-3 py-2">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Reference Studio media and documents"
        className="pointer-events-auto flex max-h-[264px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-border bg-[var(--surface-card)] p-1.5 shadow-sm"
      >
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-ink-muted">
            {emptyLabelForKind(kindFilter)}
          </p>
        ) : (
          items.map((item, index) => {
            const active = index === selectedIndex;

            return (
              <button
                key={item.uri}
                type="button"
                role="option"
                data-ref-index={index}
                data-reference-kind={item.kind}
                aria-selected={active}
                onMouseEnter={() => onHoverIndex(index)}
                onMouseDown={(event) => {
                  // Keep composer textarea focused during click selection.
                  event.preventDefault();
                  onSelect(item);
                }}
                onClick={() => onSelect(item)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-ink-muted hover:bg-foreground/[0.05]",
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <ReferenceLeadVisual reference={item} />
                  <span className="truncate text-[12.5px] font-medium text-foreground">
                    {item.title}
                  </span>
                </span>

                <span className="t-meta flex shrink-0 items-center gap-1.5 tabular-nums">
                  {item.kind === "cut" ? (
                    <CutStatusIndicator status={item.cutStatus} />
                  ) : null}
                  <span>{formatRowMeta(item)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
