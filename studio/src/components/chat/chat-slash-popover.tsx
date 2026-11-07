"use client";

import type { JSX } from "react";
import { cn } from "cn";
import type { SlashCommandEntry } from "@/lib/chat/slash-commands";

export interface ChatSlashPopoverProps {
  commands: readonly SlashCommandEntry[];
  selectedIndex: number;
  onHoverIndex: (index: number) => void;
  onSelect: (entry: SlashCommandEntry) => void;
}

export function ChatSlashPopover({
  commands,
  selectedIndex,
  onHoverIndex,
  onSelect,
}: ChatSlashPopoverProps): JSX.Element | null {
  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-30 px-3 py-2">
      <div
        role="listbox"
        aria-label="Slash commands"
        className="pointer-events-auto flex max-h-[264px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-border bg-[var(--surface-card)] p-1.5 shadow-sm"
      >
        {commands.map((entry, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={entry.command}
              type="button"
              role="option"
              aria-selected={isSelected}
              onMouseEnter={() => onHoverIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(entry);
              }}
              onClick={() => onSelect(entry)}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                isSelected
                  ? "bg-[var(--surface-inset)] text-foreground"
                  : "text-ink-muted hover:bg-[var(--surface-inset)]",
              )}
            >
              <span className="t-mono shrink-0 font-medium text-foreground">
                {`/${entry.command}`}
              </span>
              <span className="t-meta truncate">{entry.summary}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
