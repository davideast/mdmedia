"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { cn } from "cn";
import { Check, Info, ListMusic, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useAuth } from "@/lib/auth-context";
import { updateVisibility, watchMyNarrations } from "@/lib/narrations";
import {
  createPlaylist,
  toggleNarrationInPlaylist,
  watchMyPlaylists,
} from "@/lib/playlists";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  MAX_SHARED_WITH,
  type HighlightColorId,
  type Narration,
  type Playlist,
  type Visibility,
} from "@/lib/types";

const OPTIONS: ReadonlyArray<{ value: Visibility; label: string }> = [
  { value: "private", label: "Only me" },
  { value: "shared", label: "People I choose" },
  { value: "public", label: "Anyone with the link" },
];

/** Sharing, playlists, highlight color, and details for one narration. */
export function NarrationSettings({
  narration,
  narrationId,
  canEdit,
  actions,
}: {
  narration: Narration | null;
  narrationId?: string;
  canEdit: boolean;
  actions?: React.ReactNode;
}) {
  const { user } = useAuth();
  const { stream, highlightColor, setHighlightColor } = useNarration();
  const [pending, startTransition] = useTransition();
  const [invitee, setInvitee] = useState("");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [narrations, setNarrations] = useState<Narration[]>([]);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");

  useEffect(() => {
    if (!user) {
      setPlaylists([]);
      setNarrations([]);
      return;
    }
    const unsubP = watchMyPlaylists(user.uid, setPlaylists);
    const unsubN = watchMyNarrations(user.uid, setNarrations);
    return () => {
      unsubP();
      unsubN();
    };
  }, [user]);

  const validNarrationIds = useMemo(() => new Set(narrations.map((n) => n.id)), [narrations]);

  const effectiveId = narration?.id ?? narrationId ?? stream.id;
  const effectiveVoice = narration?.voice ?? stream.voice;

  const commit = (visibility: Visibility, sharedWith: string[]) => {
    if (!narration) return;
    startTransition(async () => {
      try {
        await updateVisibility(narration.id, visibility, sharedWith);
      } catch {
        toast.error("That change did not save. Try again.");
      }
    });
  };

  const addInvitee = () => {
    if (!narration) return;
    const value = invitee.trim().toLowerCase();
    if (value.length === 0) return;
    if (narration.sharedWith.includes(value)) {
      setInvitee("");
      return;
    }
    if (narration.sharedWith.length >= MAX_SHARED_WITH) {
      toast.error(`You can share with up to ${MAX_SHARED_WITH} people.`);
      return;
    }
    commit("shared", [...narration.sharedWith, value]);
    setInvitee("");
  };

  const handleTogglePlaylist = (playlist: Playlist) => {
    if (!effectiveId) return;
    startTransition(async () => {
      try {
        const added = await toggleNarrationInPlaylist(playlist, effectiveId);
        toast.success(added ? `Added to "${playlist.title}"` : `Removed from "${playlist.title}"`);
      } catch {
        toast.error("Could not update playlist.");
      }
    });
  };

  const handleCreatePlaylist = () => {
    if (!user || !effectiveId) return;
    const title = newPlaylistTitle.trim();
    if (title.length === 0) return;
    startTransition(async () => {
      try {
        await createPlaylist(user.uid, title, "", [effectiveId]);
        setNewPlaylistTitle("");
        toast.success(`Created "${title}" and added narration`);
      } catch {
        toast.error("Could not create playlist.");
      }
    });
  };

  return (
    <WorkbenchPanel
      title="Details"
      icon={<Info size={13} strokeWidth={2} />}
      actions={
        <>
          {pending ? <Loader2 size={13} className="animate-spin text-ink-muted" /> : null}
          {actions}
        </>
      }
      bodyClassName="gap-6 p-4"
    >
      <div className="grid gap-2">
        <Label className="t-label">Highlight color</Label>
        <div className="grid grid-cols-3 gap-1.5">
          {HIGHLIGHT_COLORS.map((preset) => {
            const selected = highlightColor === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setHighlightColor(preset.id as HighlightColorId)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[0.75rem] transition-all",
                  selected
                    ? "border-foreground bg-accent font-medium text-foreground"
                    : "border-border bg-card text-ink-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                <span
                  style={{ backgroundColor: preset.bg, color: preset.text }}
                  className="inline-flex h-4 w-5 flex-none items-center justify-center rounded-[3px] font-mono text-[10px] font-semibold"
                >
                  Aa
                </span>
                <span className="truncate">{preset.label.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {user && effectiveId ? (
        <div className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="t-label">Playlists</Label>
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
              {playlists.filter((p) => p.narrationIds.includes(effectiveId)).length} selected
            </span>
          </div>

          {playlists.length > 0 ? (
            <ul className="grid max-h-44 gap-1 overflow-y-auto rounded-md border border-border bg-card p-1">
              {playlists.map((playlist) => {
                const included = playlist.narrationIds.includes(effectiveId);
                return (
                  <li key={playlist.id}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => handleTogglePlaylist(playlist)}
                      aria-pressed={included}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-[0.8rem] transition-colors",
                        included
                          ? "bg-accent font-medium text-foreground"
                          : "text-ink-muted hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex size-4 flex-none items-center justify-center rounded-[3px] border transition-colors",
                            included
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong bg-background",
                          )}
                        >
                          {included ? <Check size={11} strokeWidth={2.5} /> : null}
                        </span>
                        <span className="truncate">{playlist.title}</span>
                      </span>
                      <span className="flex-none font-mono text-[11px] tabular-nums text-ink-faint">
                        {playlist.narrationIds.filter((id) => validNarrationIds.has(id)).length}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-[0.78rem] text-ink-muted">
              No playlists yet. Create one below to add this narration.
            </p>
          )}

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input
              value={newPlaylistTitle}
              placeholder="New playlist name…"
              onChange={(event) => setNewPlaylistTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreatePlaylist();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              disabled={pending || newPlaylistTitle.trim().length === 0}
              onClick={handleCreatePlaylist}
              aria-label="Create playlist with this narration"
            >
              <Plus size={15} strokeWidth={2} />
            </Button>
          </div>
        </div>
      ) : null}

      {narration !== null ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="who" className="t-label">
              Who can listen
            </Label>
            <Select
              value={narration.visibility}
              disabled={!canEdit || pending}
              onValueChange={(value) => commit(value as Visibility, narration.sharedWith)}
            >
              <SelectTrigger id="who" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {narration.visibility === "shared" && canEdit ? (
            <div className="grid gap-3">
              <Label htmlFor="invite" className="t-label">
                People
              </Label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input
                  id="invite"
                  value={invitee}
                  placeholder="Email address"
                  onChange={(event) => setInvitee(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addInvitee();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={addInvitee}
                  aria-label="Add person"
                >
                  <Plus size={15} strokeWidth={2} />
                </Button>
              </div>

              <ul className="grid max-h-48 gap-1 overflow-y-auto">
                {narration.sharedWith.map((person) => (
                  <li
                    key={person}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <span className="truncate text-[0.8rem]">{person}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${person}`}
                      onClick={() =>
                        commit(
                          "shared",
                          narration.sharedWith.filter((entry) => entry !== person),
                        )
                      }
                      className="text-ink-faint transition-colors hover:text-foreground"
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <dl className="grid gap-3">
            <div className="grid gap-0.5">
              <dt className="t-label">Voice</dt>
              <dd className="text-[0.85rem]">{narration.voice}</dd>
            </div>
            {narration.authorName ? (
              <div className="grid gap-0.5">
                <dt className="t-label">Made by</dt>
                <dd className="text-[0.85rem]">{narration.authorName}</dd>
              </div>
            ) : null}
          </dl>

          {narration.visibility === "public" ? (
            <p className="item-label-lockup t-meta">
              <Check size={14} strokeWidth={2} className="text-foreground" />
              <span>Anyone with the link can listen.</span>
            </p>
          ) : null}
        </>
      ) : (
        <>
          {effectiveVoice ? (
            <dl className="grid gap-3">
              <div className="grid gap-0.5">
                <dt className="t-label">Voice</dt>
                <dd className="text-[0.85rem]">{effectiveVoice}</dd>
              </div>
            </dl>
          ) : null}
          <p className="t-meta">Sharing options appear once the narration finishes saving.</p>
        </>
      )}
    </WorkbenchPanel>
  );
}
