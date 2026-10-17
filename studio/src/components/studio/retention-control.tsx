"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Timer } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MediaClientError, studioJson } from "@/lib/media-client";
import type { MediaType } from "@/lib/media-types";
import { TTL_PRESETS, describeTimeLeft, parseTtl, type RetentionView } from "@/lib/retention";

const USE_DEFAULT = "default";
const CUSTOM = "custom";

function when(view: RetentionView, now: number): string {
  if (view.locked) return "Locked. It stays until you unlock it.";
  if (view.effectiveExpiresAt === null) return "Kept. Nothing will delete it.";
  const date = new Date(view.effectiveExpiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const left = describeTimeLeft(view.effectiveExpiresAt, now);
  const rule = view.source === "item" ? "Set on this item." : "From your default for this kind of media.";
  return `${left === "due" ? "Due for deletion" : `Deletes in ${left}`} (${date}). ${rule}`;
}

interface RetentionState {
  view: RetentionView;
  /** When the view was read, so countdowns never call Date.now() during render. */
  at: number;
  busy: boolean;
  save: (retention: Record<string, unknown>) => Promise<void>;
}

/**
 * Loads and saves one item's retention. Returns null for anyone who does not
 * own the item, since only the owner can change it.
 */
function useRetention(type: MediaType, id: string, onChange?: (view: RetentionView) => void): RetentionState | null {
  // The view remembers which item it describes, so a stale answer for another
  // item is never shown.
  const [loaded, setLoaded] = useState<{ path: string; view: RetentionView; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/api/v1/media/${type}/${id}`;

  useEffect(() => {
    const controller = new AbortController();
    studioJson<{ retention: RetentionView }>(path, { signal: controller.signal })
      .then((body) => setLoaded({ path, view: body.retention, at: Date.now() }))
      .catch(() => {
        // Not the owner, offline, or signed out: there is nothing to control.
      });
    return () => controller.abort();
  }, [path]);

  const save = useCallback(async (retention: Record<string, unknown>) => {
    setBusy(true);
    try {
      const body = await studioJson<{ retention: RetentionView }>(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention }),
      });
      setLoaded({ path, view: body.retention, at: Date.now() });
      onChange?.(body.retention);
    } catch (error) {
      toast.error(error instanceof MediaClientError ? error.message : "Could not change retention.");
    } finally {
      setBusy(false);
    }
  }, [path, onChange]);

  if (!loaded || loaded.path !== path) return null;
  return { view: loaded.view, at: loaded.at, busy, save };
}

/** The lock switch, the "Delete after" choice, and when the item will go. */
function RetentionFields({ type, id, state }: { type: MediaType; id: string; state: RetentionState }) {
  const { view, at, busy, save } = state;
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState("");
  const customValid = parseTtl(customText) !== undefined;
  const apply = async (retention: Record<string, unknown>) => {
    await save(retention);
    setCustom(false);
    setCustomText("");
  };

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`lock-${type}-${id}`} className="t-card-title font-normal">Lock</Label>
          <p className="t-meta">Never deleted until you unlock it.</p>
        </div>
        <Switch
          id={`lock-${type}-${id}`}
          checked={view.locked}
          disabled={busy}
          onCheckedChange={(locked) => void apply({ locked })}
        />
      </div>

      {view.locked ? null : (
        <div className="grid gap-2">
          <Label htmlFor={`ttl-${type}-${id}`} className="t-card-title font-normal">Delete after</Label>
          <Select
            disabled={busy}
            value=""
            onValueChange={(value) => {
              if (value === CUSTOM) setCustom(true);
              else void apply({ ttl: value === USE_DEFAULT ? null : value });
            }}
          >
            <SelectTrigger id={`ttl-${type}-${id}`} className="w-full">
              <SelectValue placeholder="Choose how long to keep it" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={USE_DEFAULT}>Use the default</SelectItem>
              {TTL_PRESETS.map((preset) => (
                <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {custom ? (
            <form
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (customValid) void apply({ ttl: customText.trim().toLowerCase() });
              }}
            >
              <Input
                aria-label="Custom time to keep"
                placeholder="36h, 3d, 2w"
                value={customText}
                autoFocus
                onChange={(event) => setCustomText(event.target.value)}
                aria-invalid={customText.length > 0 && !customValid}
              />
              <Button type="submit" disabled={busy || !customValid}>Set</Button>
            </form>
          ) : null}
        </div>
      )}

      <p className="t-meta" role="status">{when(view, at)}</p>
    </div>
  );
}

/** Retention laid out inline, for the right panel. Renders nothing for someone else's item. */
export function RetentionPanelFields({ type, id }: { type: MediaType; id: string }) {
  const state = useRetention(type, id);
  return state ? <RetentionFields type={type} id={id} state={state} /> : null;
}

/** A compact icon that opens retention in a popover, for library rows. */
export function RetentionControl({
  type,
  id,
  className,
  onChange,
}: {
  type: MediaType;
  id: string;
  className?: string;
  onChange?: (view: RetentionView) => void;
}) {
  const state = useRetention(type, id, onChange);
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const { view, at } = state;
  const label = view.locked ? "Locked" : view.effectiveExpiresAt !== null ? `Deletes in ${describeTimeLeft(view.effectiveExpiresAt, at)}` : "Retention";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Retention: ${label}`}
          title={label}
          className={cn("text-ink-muted hover:text-foreground", className)}
        >
          {view.locked ? <Lock size={14} /> : <Timer size={14} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <RetentionFields type={type} id={id} state={state} />
      </PopoverContent>
    </Popover>
  );
}
