"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { MediaClientError, studioJson } from "@/lib/media-client";
import { MEDIA_TYPES, type MediaType } from "@/lib/media-types";
import { DEFAULT_RETENTION, TTL_PRESETS, parseTtl, type RetentionSettings } from "@/lib/retention";

type Target = MediaType | "global";
type Item = { type: string; id: string; title: string };
type Preview = { count: number; items: Item[] };
type Pending = { target: Target; ttl: string; caught: Item[] | null };

const KEEP = "keep";
const INHERIT = "inherit";
const CUSTOM = "custom";

const TARGETS: ReadonlyArray<{ target: Target; label: string; plural: string }> = [
  { target: "global", label: "Everything else", plural: "items" },
  ...MEDIA_TYPES.map((entry) => ({
    target: entry.type as Target,
    label: entry.label,
    plural: `${entry.label.toLowerCase()}s`,
  })),
];

/** The value a row's menu shows now. */
function currentValue(retention: RetentionSettings, target: Target): string {
  if (target === "global") return retention.global?.ttl ?? KEEP;
  if (!(target in retention.byType)) return INHERIT;
  return retention.byType[target]?.ttl ?? KEEP;
}

function ttlLabel(ttl: string): string {
  return TTL_PRESETS.find((preset) => preset.value === ttl)?.label ?? ttl;
}

function describe(target: Target, ttl: string): string {
  if (ttl === KEEP) return target === "global" ? "Items without their own setting are kept forever." : "Kept forever, even if everything else expires.";
  if (ttl === INHERIT) return "Follows the setting for everything else.";
  return `Deleted ${ttlLabel(ttl)} after they are made, unless locked or given their own time.`;
}

async function previewIds(query: string): Promise<Item[]> {
  return (await studioJson<Preview>(`/api/v1/retention/preview${query}`)).items;
}

/** How long generations are kept: a default per kind of media, and one for everything else. */
export function RetentionSettings() {
  const { profile } = useAuth();
  const retention = profile?.settings.retention ?? DEFAULT_RETENTION;
  const [pending, setPending] = useState<Pending | null>(null);
  const [customFor, setCustomFor] = useState<Target | null>(null);
  const [customText, setCustomText] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(target: Target, ttl: string, retroactive: boolean) {
    setBusy(true);
    try {
      await studioJson("/api/v1/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, ttl, retroactive }),
      });
      setPending(null);
      setCustomFor(null);
      setCustomText("");
      toast.success("Retention updated");
    } catch (error) {
      toast.error(error instanceof MediaClientError ? error.message : "Could not change retention.");
    } finally {
      setBusy(false);
    }
  }

  /** Choosing a time asks first; keeping something forever cannot delete anything, so it saves at once. */
  async function choose(target: Target, ttl: string) {
    if (ttl === KEEP || ttl === INHERIT) return void save(target, ttl, false);
    setPending({ target, ttl, caught: null });
    try {
      const query = `?target=${target}&ttl=${ttl}`;
      const [already, withThis] = await Promise.all([previewIds(""), previewIds(`${query}&retroactive=1`)]);
      const due = new Set(already.map((item) => `${item.type}:${item.id}`));
      setPending({ target, ttl, caught: withThis.filter((item) => !due.has(`${item.type}:${item.id}`)) });
    } catch (error) {
      setPending(null);
      toast.error(error instanceof MediaClientError ? error.message : "Could not check your library.");
    }
  }

  async function deleteNow() {
    setBusy(true);
    try {
      const result = await studioJson<{ purged: number; failed: number; truncated: boolean }>("/api/v1/retention/sweep", { method: "POST" });
      toast.success(result.purged === 0 ? "Nothing has expired" : `Deleted ${result.purged} expired ${result.purged === 1 ? "item" : "items"}${result.truncated ? "; more remain" : ""}`);
    } catch (error) {
      toast.error(error instanceof MediaClientError ? error.message : "Could not delete expired items.");
    } finally {
      setBusy(false);
    }
  }

  const caught = pending?.caught ?? [];
  const plural = TARGETS.find((entry) => entry.target === pending?.target)?.plural ?? "items";

  return (
    <div className="grid gap-5">
      {TARGETS.map(({ target, label }) => {
        const value = currentValue(retention, target);
        return (
          <div key={target} className="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-6">
            <div className="grid min-w-0 gap-1">
              <Label htmlFor={`retention-${target}`} className="t-card-title font-normal">{label}</Label>
              <p className="t-meta">{describe(target, value)}</p>
            </div>
            <div className="grid gap-2">
              <Select
                value={TTL_PRESETS.some((preset) => preset.value === value) || value === KEEP || value === INHERIT ? value : CUSTOM}
                disabled={busy}
                onValueChange={(next) => (next === CUSTOM ? setCustomFor(target) : void choose(target, next))}
              >
                <SelectTrigger id={`retention-${target}`} className="w-full">
                  <SelectValue>{value === KEEP ? "Keep forever" : value === INHERIT ? "Same as everything else" : ttlLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {target === "global" ? null : <SelectItem value={INHERIT}>Same as everything else</SelectItem>}
                  <SelectItem value={KEEP}>Keep forever</SelectItem>
                  {TTL_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>Delete after {preset.label}</SelectItem>
                  ))}
                  <SelectItem value={CUSTOM}>Custom…</SelectItem>
                </SelectContent>
              </Select>
              {customFor === target ? (
                <form
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (parseTtl(customText) !== undefined) void choose(target, customText.trim().toLowerCase());
                  }}
                >
                  <Input
                    aria-label={`Custom time for ${label}`}
                    placeholder="36h, 3d, 2w"
                    value={customText}
                    autoFocus
                    onChange={(event) => setCustomText(event.target.value)}
                    aria-invalid={customText.length > 0 && parseTtl(customText) === undefined}
                  />
                  <Button type="submit" disabled={busy || parseTtl(customText) === undefined}>Review</Button>
                </form>
              ) : null}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="t-meta">Expired items are deleted automatically about every 10 minutes.</p>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void deleteNow()}>Delete expired items now</Button>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => (open || busy ? undefined : setPending(null))}>
        <DialogContent>
          <DialogTitle>
            {pending ? `Delete ${plural} after ${ttlLabel(pending.ttl)}?` : "Checking your library"}
          </DialogTitle>
          <DialogDescription>
            {pending?.caught === null
              ? "Checking which existing items this would reach…"
              : caught.length === 0
                ? "New items will follow this. None of your existing items are older than that."
                : `New items will follow this. ${caught.length} existing ${caught.length === 1 ? "item is" : "items are"} already older than that. They are kept unless you apply it to them too, and then they are deleted within a minute.`}
          </DialogDescription>
          {caught.length > 0 ? (
            <ul className="grid max-h-40 gap-1 overflow-auto text-sm text-ink-muted">
              {caught.slice(0, 8).map((item) => <li key={`${item.type}:${item.id}`} className="truncate">{item.title || item.id}</li>)}
              {caught.length > 8 ? <li>and {caught.length - 8} more</li> : null}
            </ul>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
            <Button type="button" variant="outline" disabled={busy || pending?.caught === null} onClick={() => pending && void save(pending.target, pending.ttl, false)}>
              {caught.length > 0 ? "Apply to new items only" : "Apply"}
            </Button>
            {caught.length > 0 ? (
              <Button type="button" variant="destructive" disabled={busy} onClick={() => pending && void save(pending.target, pending.ttl, true)}>
                Delete {caught.length} existing too
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
