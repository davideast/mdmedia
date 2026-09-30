"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "cn";
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  GripVertical,
  ListMusic,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useRouteQuery, useWorkspaceField } from "@/components/shell/workspace-provider";
import { useAuth } from "@/lib/auth-context";
import { watchMyNarrations } from "@/lib/narrations";
import {
  createPlaylist,
  deletePlaylist,
  reorderPlaylistTracks,
  toggleNarrationInPlaylist,
  updatePlaylist,
  watchMyPlaylists,
} from "@/lib/playlists";
import type { Narration, Playlist } from "@/lib/types";
import { readDownloadCatalog, subscribeDownloads } from "@/lib/download-catalog";
import { savePlaylistDownload } from "@/lib/playlist-download";
import { useConnectivity } from "@/lib/connectivity";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PlaylistsPage() {
  const { user } = useAuth();
  const online = useConnectivity() === 'online';
  const { stream, queue, playPlaylist } = useNarration();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [narrations, setNarrations] = useState<Narration[]>([]);
  const [selectedPlaylist] = useRouteQuery("playlist");
  const [newTitle, setNewTitle] = useWorkspaceField("newTitle", "");
  const [newDescription, setNewDescription] = useWorkspaceField("newDescription", "");
  const [editingId, setEditingId] = useWorkspaceField<string | null>("editingId", null);
  const [editTitle, setEditTitle] = useWorkspaceField("editTitle", "");
  const [editDescription, setEditDescription] = useWorkspaceField("editDescription", "");
  const [downloaded, setDownloaded] = useState<Record<string, number>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!user) return;
    const reload = () => { void readDownloadCatalog(user.uid).then((catalog) =>
      setDownloaded(Object.fromEntries(catalog.playlists.map((item) => [item.id, item.sourceUpdatedAt])))).catch(() => {}); };
    reload();
    return subscribeDownloads(reload);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const unsubPlaylists = watchMyPlaylists(user.uid, (items) => { setPlaylists(items); setPlaylistsLoaded(true); });
    const unsubNarrations = watchMyNarrations(user.uid, setNarrations);
    return () => {
      unsubPlaylists();
      unsubNarrations();
    };
  }, [user]);

  const narrationMap = useMemo(() => {
    const map = new Map<string, Narration>();
    for (const item of narrations) {
      map.set(item.id, item);
    }
    return map;
  }, [narrations]);

  const handleCreate = () => {
    if (!user) return;
    const title = newTitle.trim();
    if (!title) return;
    try {
      createPlaylist(user.uid, title, newDescription.trim(), []);
      setNewTitle("");
      setNewDescription("");
      toast.success(`Created "${title}"`);
    } catch {
      toast.error("Could not create playlist.");
    }
  };

  const startEdit = (playlist: Playlist) => {
    setEditingId(playlist.id);
    setEditTitle(playlist.title);
    setEditDescription(playlist.description);
  };

  const handleSaveEdit = (playlistId: string) => {
    const title = editTitle.trim();
    if (!title) return;
    try {
      updatePlaylist(playlistId, {
        title,
        description: editDescription.trim(),
      });
      setEditingId(null);
      toast.success("Playlist updated");
    } catch {
      toast.error("Could not save changes.");
    }
  };

  const handleDelete = (playlist: Playlist) => {
    try {
      deletePlaylist(playlist.id);
      if (editingId === playlist.id) setEditingId(null);
      toast.success(`Deleted "${playlist.title}"`);
    } catch {
      toast.error("Could not delete playlist.");
    }
  };

  const handleToggleTrack = (playlist: Playlist, narrationId: string) => {
    try {
      toggleNarrationInPlaylist(playlist, narrationId);
    } catch {
      toast.error("Could not update playlist tracks.");
    }
  };

  const [dragState, setDragState] = useState<{
    playlistId: string;
    fromIndex: number;
    overIndex: number | null;
  } | null>(null);

  const handleReorderTracks = (playlist: Playlist, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const currentIds = [...playlist.narrationIds];
    const [movedId] = currentIds.splice(fromIndex, 1);
    if (!movedId) return;
    currentIds.splice(toIndex, 0, movedId);

    // If this playlist is currently queued and playing, update the active queue tracks too
    if (queue?.playlistId === playlist.id) {
      const updatedTracks = currentIds
        .map((id) => narrationMap.get(id))
        .filter((item): item is Narration => item !== undefined);
      const activeTrackIndex = updatedTracks.findIndex((t) => t.id === stream.id);
      if (activeTrackIndex >= 0) {
        // Retain current track position in the reordered queue
      }
    }

    try {
      reorderPlaylistTracks(playlist.id, currentIds);
    } catch {
      toast.error("Could not reorder tracks.");
    }
  };

  const handleMoveTrack = (playlist: Playlist, index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= playlist.narrationIds.length) return;
    handleReorderTracks(playlist, index, targetIndex);
  };

  const onDragStart = (event: React.DragEvent, playlistId: string, index: number) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${playlistId}:${index}`);
    setDragState({ playlistId, fromIndex: index, overIndex: null });
  };

  const onDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragState && dragState.overIndex !== index) {
      setDragState((prev) => (prev ? { ...prev, overIndex: index } : null));
    }
  };

  const onDrop = (event: React.DragEvent, playlist: Playlist, toIndex: number) => {
    event.preventDefault();
    if (dragState && dragState.playlistId === playlist.id) {
      handleReorderTracks(playlist, dragState.fromIndex, toIndex);
    }
    setDragState(null);
  };

  const onDragEnd = () => {
    setDragState(null);
  };

  const handlePlayPlaylist = (playlist: Playlist, tracks: Narration[], startIndex = 0) => {
    if (tracks.length === 0) {
      toast.info("Add at least one narration to play this playlist.");
      return;
    }
    const isThisPlaylistActive =
      queue?.playlistId === playlist.id &&
      stream.id === tracks[startIndex]?.id &&
      stream.player !== null;

    if (isThisPlaylistActive) {
      if (stream.playing) {
        stream.player?.pause();
      } else {
        stream.player?.play();
      }
      return;
    }

    playPlaylist(playlist, tracks, startIndex);
  };

  const handleDownloadPlaylist = async (playlist: Playlist) => {
    if (!user || !online) return;
    setDownloadProgress((value) => ({ ...value, [playlist.id]: 'Preparing…' }));
    try {
      await savePlaylistDownload(user.uid, playlist, narrationMap, (done, total) =>
        setDownloadProgress((value) => ({ ...value, [playlist.id]: `${done}/${total}` })));
      toast.success(`Saved "${playlist.title}" to Downloads`);
    } catch (error) {
      toast.error((error as Error).message || 'Could not save playlist. Retry the download.');
    } finally {
      setDownloadProgress((value) => { const next = { ...value }; delete next[playlist.id]; return next; });
    }
  };

  return (
    <WorkbenchPanel
      workspacePage
      title={selectedPlaylist ? playlists.find((playlist) => playlist.id === selectedPlaylist)?.title ?? "Playlist" : "Playlists"}
      icon={<ListMusic size={13} strokeWidth={2} />}
      viewGrid
      gridVariant="wide"
    >
      {selectedPlaylist ? <Link href="/playlists" className="text-sm text-primary underline underline-offset-2">All playlists</Link> : null}
      {/* Create new playlist bar */}
      {!selectedPlaylist ? (
        <div className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4">
          <div className="t-label">New playlist</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
            <Input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Playlist title"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreate();
                }
              }}
            />
            <Input
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              placeholder="Optional description"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreate();
                }
              }}
            />
            <Button
              type="button"
              disabled={newTitle.trim().length === 0}
              onClick={handleCreate}
            >
              <Plus size={14} strokeWidth={2} />
              Create playlist
            </Button>
          </div>
        </div>

      ) : null}
        {/* Playlists list */}
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          {selectedPlaylist && playlistsLoaded && !playlists.some((item) => item.id === selectedPlaylist) ? (
            <p role="status" className="t-lead pt-6">This playlist is unavailable or was deleted. <Link href="/playlists" className="text-primary underline">All playlists</Link></p>
          ) : playlists.length === 0 ? (
            <p className="t-lead pt-6">
              No playlists yet. Create one above or add any narration from its right-hand Details panel.
            </p>
          ) : (
            playlists.filter((playlist) => !selectedPlaylist || playlist.id === selectedPlaylist).map((playlist) => {
              const tracks = playlist.narrationIds
                .map((id) => narrationMap.get(id))
                .filter((item): item is Narration => item !== undefined);
              const totalMs = tracks.reduce((acc, item) => acc + item.durationMs, 0);
              const isEditing = editingId === playlist.id;
              const isActivePlaylist = queue?.playlistId === playlist.id;
              const isPlayingPlaylist = isActivePlaylist && stream.playing;

              return (
                <section
                  key={playlist.id}
                  className={cn(
                    "grid min-w-0 grid-cols-1 gap-4 rounded-lg border bg-card p-4 transition-colors sm:p-5",
                    isActivePlaylist ? "border-border-strong" : "border-border",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3.5">
                      <button
                        type="button"
                        onClick={() => handlePlayPlaylist(playlist, tracks, 0)}
                        disabled={tracks.length === 0}
                        aria-label={isPlayingPlaylist ? `Pause ${playlist.title}` : `Play ${playlist.title}`}
                        className="inline-flex size-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                      >
                        {isPlayingPlaylist ? (
                          <Pause size={15} strokeWidth={2.2} fill="currentColor" />
                        ) : (
                          <Play size={15} strokeWidth={2.2} fill="currentColor" className="translate-x-[1px]" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <div className="grid max-w-xl gap-2">
                            <Input
                              value={editTitle}
                              onChange={(event) => setEditTitle(event.target.value)}
                              placeholder="Playlist title"
                            />
                            <Input
                              value={editDescription}
                              onChange={(event) => setEditDescription(event.target.value)}
                              placeholder="Description"
                            />
                            <div className="flex items-center gap-2 pt-1">
                              <Button
                                type="button"
                                size="sm"
                                disabled={editTitle.trim().length === 0}
                                onClick={() => handleSaveEdit(playlist.id)}
                              >
                                <Check size={13} strokeWidth={2} />
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <h2 className="t-card-title min-w-0 [overflow-wrap:anywhere]"><Link href={`/playlists?playlist=${encodeURIComponent(playlist.id)}`} className="hover:text-primary">{playlist.title}</Link></h2>
                              <span className="inline-flex flex-wrap items-center gap-x-2.5 t-mono tabular-nums text-ink-faint">
                                <span>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</span>
                                <span>{formatDuration(totalMs)}</span>
                              </span>
                            </div>
                            {playlist.description ? (
                              <p className="t-card-desc mt-0.5 [overflow-wrap:anywhere]">{playlist.description}</p>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>

                    {!isEditing ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void handleDownloadPlaylist(playlist)}
                          disabled={!online || tracks.length === 0 || !!downloadProgress[playlist.id]}
                          aria-label={`${downloaded[playlist.id] ? 'Update' : 'Download'} ${playlist.title} for offline listening`}
                          title={downloadProgress[playlist.id] || (downloaded[playlist.id] ? 'Update downloaded playlist' : 'Download playlist')}
                          className="size-9 sm:size-6"
                        >
                          {downloadProgress[playlist.id] ? <Loader2 size={13} className="animate-spin" /> : downloaded[playlist.id] && downloaded[playlist.id] >= playlist.updatedAt ? <Check size={13} /> : <Download size={13} />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => startEdit(playlist)}
                          aria-label={`Edit ${playlist.title}`}
                          className="size-9 sm:size-6"
                        >
                          <Pencil size={13} strokeWidth={2} />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDelete(playlist)}
                          aria-label={`Delete ${playlist.title}`}
                          className="size-9 sm:size-6"
                        >
                          <Trash2 size={13} strokeWidth={2} />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  {/* Tracks table */}
                  {tracks.length > 0 ? (
                    <ol className="grid min-w-0 grid-cols-1 divide-y divide-border rounded-md border border-border bg-background">
                      {tracks.map((track, idx) => {
                        const isTrackActive = stream.id === track.id;
                        const isTrackPlaying = isTrackActive && stream.playing;
                        return (
                          <li
                            key={track.id}
                            draggable
                            onDragStart={(event) => onDragStart(event, playlist.id, idx)}
                            onDragOver={(event) => onDragOver(event, idx)}
                            onDrop={(event) => onDrop(event, playlist, idx)}
                            onDragEnd={onDragEnd}
                            className={cn(
                              "group flex min-w-0 flex-col items-stretch gap-2 px-3 py-2 text-[0.83rem] transition-colors select-none sm:flex-row sm:items-center sm:justify-between",
                              isTrackActive ? "bg-accent/70" : "hover:bg-muted/60",
                              dragState?.playlistId === playlist.id &&
                                dragState.fromIndex === idx &&
                                "opacity-40 bg-muted/80",
                              dragState?.playlistId === playlist.id &&
                                dragState.overIndex === idx &&
                                dragState.fromIndex !== idx &&
                                "border-t-2 border-primary bg-accent/40",
                            )}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span
                                className="cursor-grab active:cursor-grabbing p-0.5 text-ink-faint transition-colors hover:text-foreground"
                                title="Drag to reorder"
                              >
                                <GripVertical size={13} strokeWidth={2} />
                              </span>

                              <button
                                type="button"
                                onClick={() => handlePlayPlaylist(playlist, tracks, idx)}
                                aria-label={isTrackPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                                className="inline-flex size-10 flex-none items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-accent hover:text-foreground sm:size-6"
                              >
                                {isTrackPlaying ? (
                                  <AudioLines size={13} strokeWidth={2.2} className="text-foreground" />
                                ) : (
                                  <Play size={12} strokeWidth={2.2} className="translate-x-[0.5px]" />
                                )}
                              </button>
                              <Link
                                href={`/narration/${track.id}`}
                                className="min-w-0 flex-1 font-medium text-foreground underline-offset-4 [overflow-wrap:anywhere] hover:underline sm:truncate"
                              >
                                {track.title}
                              </Link>
                            </div>

                            <div className="flex min-w-0 items-center justify-end gap-3 sm:flex-none">
                              <div className="playlist-reorder-controls flex items-center gap-0.5 transition-opacity">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleMoveTrack(playlist, idx, "up");
                                  }}
                                  aria-label="Move track up"
                                  title="Move track up"
                                  className="inline-flex size-10 items-center justify-center rounded text-ink-faint transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-20 sm:size-6"
                                >
                                  <ChevronUp size={12} strokeWidth={2.2} />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === tracks.length - 1}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleMoveTrack(playlist, idx, "down");
                                  }}
                                  aria-label="Move track down"
                                  title="Move track down"
                                  className="inline-flex size-10 items-center justify-center rounded text-ink-faint transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-20 sm:size-6"
                                >
                                  <ChevronDown size={12} strokeWidth={2.2} />
                                </button>
                              </div>

                              <span className="t-mono hidden text-ink-muted sm:inline">
                                {track.voice}
                              </span>
                              <span className="t-mono tabular-nums text-ink-faint">
                                {formatDuration(track.durationMs)}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleToggleTrack(playlist, track.id)}
                                aria-label={`Remove ${track.title} from ${playlist.title}`}
                                className="inline-flex size-10 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-muted hover:text-foreground sm:size-6"
                              >
                                <X size={13} strokeWidth={2} />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-[0.8rem] text-ink-muted">
                      No tracks in this playlist yet. Click Edit to add narrations or add them from any narration’s Details panel.
                    </p>
                  )}

                  {/* When editing, allow toggling any narration into/out of this playlist */}
                  {isEditing && narrations.length > 0 ? (
                    <div className="grid gap-2 border-t border-border pt-3">
                      <div className="t-label">Add or remove narrations</div>
                      <ul className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-border bg-background p-1.5">
                        {narrations.map((item) => {
                          const included = playlist.narrationIds.includes(item.id);
                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                onClick={() => handleToggleTrack(playlist, item.id)}
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[0.8rem] transition-colors",
                                  included
                                    ? "bg-accent font-medium text-foreground"
                                    : "text-ink-muted hover:bg-muted hover:text-foreground",
                                )}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span
                                    className={cn(
                                      "inline-flex size-4 flex-none items-center justify-center rounded-[3px] border",
                                      included
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border-strong bg-background",
                                    )}
                                  >
                                    {included ? <Check size={11} strokeWidth={2.5} /> : null}
                                  </span>
                                  <span className="block min-w-0 truncate">{item.title}</span>
                                </span>
                                <span className="t-mono flex-none tabular-nums text-ink-faint">
                                  {formatDuration(item.durationMs)}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </section>
              );
            })
          )}
        </div>
    </WorkbenchPanel>
  );
}
