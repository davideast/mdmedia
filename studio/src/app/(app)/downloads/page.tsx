'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, HardDriveDownload, ListMusic, Loader2, LogOut, Pause, Play, RefreshCw, Search, Trash2, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useOfflinePlayback } from '@/components/shell/offline-playback-provider';
import { useNarration } from '@/components/shell/narration-provider';
import { useAuth } from '@/lib/auth-context';
import { useConnectivity } from '@/lib/connectivity';
import {
  downloadMediaStore,
  importLegacyDownloads,
  listLegacyDownloads,
  readDownloadCatalog,
  removeDownloadedPlaylist,
  removeIndividualDownload,
  removePendingPlaylist,
  subscribeDownloads,
  type DownloadCatalog,
  type DownloadedTrack,
} from '@/lib/download-catalog';
import { watchMyNarrations } from '@/lib/narrations';
import { savePlaylistDownload } from '@/lib/playlist-download';
import { watchMyPlaylists } from '@/lib/playlists';
import type { Narration, Playlist } from '@/lib/types';
import type { NarrationTimingsFile } from '@/lib/wav';

function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function DownloadsPage() {
  const { user, signOutUser } = useAuth();
  const connectivity = useConnectivity();
  const online = connectivity === 'online';
  const { stream } = useNarration();
  const playback = useOfflinePlayback();
  const [catalog, setCatalog] = useState<DownloadCatalog | null>(null);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [legacy, setLegacy] = useState<Array<{ id: string; timings: NarrationTimingsFile }>>([]);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [sourcePlaylists, setSourcePlaylists] = useState<Playlist[]>([]);
  const [sourceTracks, setSourceTracks] = useState<Narration[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    try {
      const next = await readDownloadCatalog(user.uid);
      const store = downloadMediaStore(user.uid);
      const checks = await Promise.all(Object.keys(next.tracks).map(async (id) => [id, await store.has(id)] as const));
      setCatalog(next);
      setAvailable(Object.fromEntries(checks));
      setError(null);
    } catch {
      setError('Could not read downloads on this device.');
    }
  }, [user]);

  useEffect(() => {
    queueMicrotask(() => { void reload(); });
    return subscribeDownloads(() => { void reload(); });
  }, [reload]);

  useEffect(() => {
    if (!user || !online) return;
    const stopPlaylists = watchMyPlaylists(user.uid, setSourcePlaylists);
    const stopTracks = watchMyNarrations(user.uid, setSourceTracks);
    return () => { stopPlaylists(); stopTracks(); };
  }, [user, online]);

  useEffect(() => {
    if (!user || !online || localStorage.getItem(`mdmedia.legacy-reviewed.v1.${user.uid}`)) return;
    void listLegacyDownloads().then(setLegacy).catch(() => {});
  }, [user, online]);

  const sourceMap = useMemo(() => new Map(sourcePlaylists.map((item) => [item.id, item])), [sourcePlaylists]);
  const trackMap = useMemo(() => new Map(sourceTracks.map((item) => [item.id, item])), [sourceTracks]);
  const needle = query.trim().toLowerCase();
  const playlists = (catalog?.playlists ?? []).filter((item) =>
    item.title.toLowerCase().includes(needle) || item.narrationIds.some((id) => catalog?.tracks[id]?.title.toLowerCase().includes(needle)));
  const pending = (catalog?.pendingPlaylists ?? []).filter((item) =>
    !catalog?.playlists.some((saved) => saved.id === item.id) && item.title.toLowerCase().includes(needle));
  const pendingById = new Map((catalog?.pendingPlaylists ?? []).map((item) => [item.id, item]));
  const grouped = new Set((catalog?.playlists ?? []).flatMap((item) => item.narrationIds));
  const individualIds = (catalog?.individualIds ?? []).filter((id) => !grouped.has(id) && catalog?.tracks[id]?.title.toLowerCase().includes(needle));

  const play = async (ids: string[], index: number, title?: string) => {
    stream.player?.pause();
    try { await playback.playTracks(ids, index, title); } catch (error) { toast.error((error as Error).message); }
  };

  const update = async (id: string) => {
    if (!user || !online) return;
    const source = sourceMap.get(id);
    if (!source) { toast.error('Open Playlists when online to restore this playlist.'); return; }
    setFailed((value) => ({ ...value, [id]: false }));
    setProgress((value) => ({ ...value, [id]: 'Preparing…' }));
    try {
      await savePlaylistDownload(user.uid, source, trackMap, (done, total) =>
        setProgress((value) => ({ ...value, [id]: `${done} of ${total} saved` })));
      toast.success(`Updated "${source.title}"`);
    } catch (error) {
      setFailed((value) => ({ ...value, [id]: true }));
      toast.error((error as Error).message || 'Could not update playlist.');
    } finally {
      setProgress((value) => { const next = { ...value }; delete next[id]; return next; });
    }
  };

  const trackRow = (track: DownloadedTrack, ids: string[], index: number, removable: boolean, playlistTitle?: string, enabled = true) => (
    <li key={track.id} className="flex min-w-0 items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <button
        type="button"
        onClick={() => void play(ids, index, playlistTitle)}
        disabled={!enabled || !available[track.id]}
        aria-label={`${playback.track?.id === track.id && playback.playing ? 'Restart' : 'Play'} ${track.title}`}
        className="inline-flex size-9 flex-none items-center justify-center rounded-full text-ink-muted hover:bg-accent hover:text-foreground disabled:opacity-35"
      >
        {playback.track?.id === track.id && playback.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.85rem] font-medium text-foreground">{track.title}</div>
        <div className="t-mono text-[0.72rem] text-ink-muted">{track.voice || 'Narration'} · {duration(track.durationMs)}{available[track.id] ? '' : ' · Missing from device'}</div>
      </div>
      {removable ? (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${track.title} download`} title="Remove download" onClick={() => {
          if (!user) return;
          void removeIndividualDownload(user.uid, track.id).then(() => { if (playback.track?.id === track.id) playback.stop(); toast.success('Download removed'); }).catch(() => toast.error('Could not remove download.'));
        }}><Trash2 size={14} /></Button>
      ) : null}
    </li>
  );

  return (
    <WorkbenchPanel title="Downloads" icon={<HardDriveDownload size={13} strokeWidth={2} />} viewGrid gridVariant="wide">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="t-section-title">Downloads</h1>
          <p className="t-lead">Saved on this device for listening without Studio.</p>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-ink-muted">
            {online ? <Check size={12} /> : <WifiOff size={12} />}
            {connectivity === 'checking' ? 'Checking connection' : online ? 'Online' : 'Offline'}
          </span>
          <Button type="button" variant="ghost" size="sm" title="Sign out and lock downloads on this device" onClick={() => void signOutUser()}><LogOut size={13} /> Sign out</Button>
        </div>
      </div>

      {online && legacy.length > 0 ? (
        <div className="rounded-lg border border-primary/40 bg-card p-4">
          <h2 className="t-card-title">Review earlier downloads</h2>
          <p className="t-card-desc mt-1">{legacy.length} saved {legacy.length === 1 ? 'narration was' : 'narrations were'} found from the earlier offline player. Import them into {user?.displayName || 'this account'} only if they belong to you.</p>
          <ul className="mt-3 max-h-28 overflow-auto text-sm text-ink-muted">{legacy.map((item) => <li key={item.id}>{item.timings.title || item.id}</li>)}</ul>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={importing} onClick={() => {
              if (!user) return;
              setImporting(true);
              void importLegacyDownloads(user.uid, legacy).then(() => {
                localStorage.setItem(`mdmedia.legacy-reviewed.v1.${user.uid}`, 'imported');
                setLegacy([]);
                toast.success('Earlier downloads imported');
              }).catch(() => toast.error('Import stopped. You can retry.')).finally(() => setImporting(false));
            }}>{importing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Import to my downloads</Button>
            <Button size="sm" variant="ghost" disabled={importing} onClick={() => {
              if (user) localStorage.setItem(`mdmedia.legacy-reviewed.v1.${user.uid}`, 'skipped');
              setLegacy([]);
            }}>Skip</Button>
          </div>
        </div>
      ) : null}

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search downloads…" className="h-10 rounded-full pl-9" />
      </div>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!catalog && !error ? <p className="t-lead">Loading downloads…</p> : null}
      {catalog && playlists.length === 0 && pending.length === 0 && individualIds.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <HardDriveDownload size={24} className="text-ink-muted" />
          <h2 className="t-card-title">{needle ? 'No matching downloads' : 'No downloads on this device yet'}</h2>
          <p className="t-card-desc">{online ? 'Use the download action in Library or Playlists to save audio here.' : 'Connect to Studio to save narrations for offline listening.'}</p>
          {online ? <Button asChild variant="outline" size="sm"><a href="/library">Open Library</a></Button> : null}
        </div>
      ) : null}

      {playlists.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="t-label">Downloaded playlists ({playlists.length})</h2>
          {playlists.map((playlist) => {
            const complete = playlist.narrationIds.every((id) => available[id]);
            const source = sourceMap.get(playlist.id);
            const newer = source && source.updatedAt > playlist.sourceUpdatedAt;
            return (
              <div key={playlist.id} className="rounded-lg border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <ListMusic size={18} className="flex-none text-primary" />
                    <div className="min-w-0">
                      <h3 className="t-card-title truncate">{playlist.title}</h3>
                      <p className="t-card-desc">{playlist.narrationIds.length} tracks · {newer ? 'Update available' : 'Saved playlist'}{complete ? '' : ' · Incomplete on device'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="secondary" disabled={!complete} onClick={() => void play(playlist.narrationIds, 0, playlist.title)}><Play size={13} /> Play</Button>
                    <Button size="sm" variant="outline" disabled={!online || !source || !!progress[playlist.id]} title={!online ? 'Requires Studio connection' : undefined} onClick={() => void update(playlist.id)}>
                      {progress[playlist.id] ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      {failed[playlist.id] || pendingById.has(playlist.id) ? 'Retry' : newer ? 'Update' : 'Refresh'}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${playlist.title} download`} title="Remove playlist download" onClick={() => {
                      if (!user) return;
                      void removeDownloadedPlaylist(user.uid, playlist.id).then(() => { if (playback.playlistTitle === playlist.title) playback.stop(); toast.success('Playlist download removed'); }).catch(() => toast.error('Could not remove playlist download.'));
                    }}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {progress[playlist.id] ? <p role="status" className="px-4 pb-2 text-xs text-ink-muted">{progress[playlist.id]}</p> : null}
                {failed[playlist.id] || pendingById.has(playlist.id) ? <p className="px-4 pb-2 text-xs text-destructive">Update stopped. The previous playlist is still playable; retry when ready.</p> : null}
                {playlist.description ? <p className="px-4 pb-3 text-sm text-ink-muted">{playlist.description}</p> : null}
                <ol className="border-t border-border bg-background">{playlist.narrationIds.map((id, index) => catalog?.tracks[id] ? trackRow(catalog.tracks[id], playlist.narrationIds, index, false, playlist.title, complete) : <li key={id} className="p-3 text-sm text-destructive">Missing track metadata</li>)}</ol>
              </div>
            );
          })}
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="t-label">Playlist downloads to finish ({pending.length})</h2>
          {pending.map((item) => {
            const saved = item.narrationIds.filter((id) => available[id]).length;
            return <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
              <div className="min-w-0">
                <h3 className="t-card-title truncate">{item.title}</h3>
                <p className="t-card-desc">{saved} of {item.narrationIds.length} tracks saved · Finish before playing</p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" disabled={!online || !sourceMap.has(item.id) || !!progress[item.id]} title={!online ? 'Requires Studio connection' : undefined} onClick={() => void update(item.id)}>
                  {progress[item.id] ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retry
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Discard ${item.title} partial download`} onClick={() => {
                  if (!user) return;
                  void removePendingPlaylist(user.uid, item.id).then(() => toast.success('Partial download removed')).catch(() => toast.error('Could not remove partial download.'));
                }}><Trash2 size={14} /></Button>
              </div>
            </div>;
          })}
        </section>
      ) : null}

      {individualIds.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="t-label">Individual downloads ({individualIds.length})</h2>
          <ol className="rounded-lg border border-border bg-card">{individualIds.map((id, index) => catalog?.tracks[id] ? trackRow(catalog.tracks[id], individualIds, index, true) : null)}</ol>
        </section>
      ) : null}
      <div className="h-24" aria-hidden />
    </WorkbenchPanel>
  );
}
