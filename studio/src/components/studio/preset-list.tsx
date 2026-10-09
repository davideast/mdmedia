"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TextPreset } from "@/lib/types";

/** Saved presets with a way to remove each. Built-in presets are not listed. */
export function PresetList({
  label,
  presets,
  onDelete,
}: {
  label: string;
  presets: readonly TextPreset[];
  onDelete: (id: string) => void;
}) {
  if (presets.length === 0) {
    return <p className="t-meta">No saved {label.toLowerCase()} presets yet. Save one from the composer.</p>;
  }
  return (
    <ul aria-label={`Saved ${label.toLowerCase()} presets`} className="grid min-w-0 gap-2">
      {presets.map((preset) => (
        <li key={preset.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-border px-3 py-2">
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate text-[0.85rem] text-foreground">{preset.name}</span>
            <span title={preset.text} className="line-clamp-2 whitespace-pre-wrap text-[0.75rem] text-ink-muted">{preset.text}</span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(preset.id)}
            aria-label={`Delete ${preset.name} preset`} className="size-7 p-0 text-ink-muted hover:text-destructive">
            <Trash2 size={13} />
          </Button>
        </li>
      ))}
    </ul>
  );
}
