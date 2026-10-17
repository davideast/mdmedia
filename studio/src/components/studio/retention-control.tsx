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

/**
 * Lock an item or choose how long it is kept. Renders nothing for anyone who
 * does not own the item, since only the owner can change its retention.
 */
export function RetentionControl({
  type,
  id,
  compact = false,
  className,
  onChange,
}: {
  type: MediaType;
  id: string;
  compact?: boolean;
  className?: string;
  onChange?: (view: RetentionView) => void;
}) {
  // The view remembers which item and moment it describes, so a stale answer
  // for another item is never shown and nothing impure runs during render.
  const [loaded, setLoaded] = useState<{ path: string; view: RetentionView; at: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState("");
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
      setCustom(false);
      setCustomText("");
      onChange?.(body.retention);
    } catch (error) {
      toast.error(error instanceof MediaClientError ? error.message : "Could not change retention.");
    } finally {
      setBusy(false);
    }
  }, [path, onChange]);

  if (!loaded || loaded.path !== path) return null;
  const { view, at } = loaded;

  const label = view.locked ? "Locked" : view.effectiveExpiresAt !== null ? `Deletes in ${describeTimeLeft(view.effectiveExpiresAt, at)}` : "Retention";
  const customValid = parseTtl(customText) !== undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          aria-label={`Retention: ${label}`}
          title={label}
          className={cn("gap-1.5 text-ink-muted hover:text-foreground", className)}
        >
          {view.locked ? <Lock size={14} /> : <Timer size={14} />}
          {compact ? null : <span>{label}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 max-w-[calc(100vw-2rem)] gap-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`lock-${type}-${id}`} className="t-card-title font-normal">Lock</Label>
            <p className="t-meta">Never deleted until you unlock it.</p>
          </div>
          <Switch
            id={`lock-${type}-${id}`}
            checked={view.locked}
            disabled={busy}
            onCheckedChange={(locked) => void save({ locked })}
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
                else void save({ ttl: value === USE_DEFAULT ? null : value });
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
                  if (customValid) void save({ ttl: customText.trim().toLowerCase() });
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
      </PopoverContent>
    </Popover>
  );
}
