'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlaybackTransport } from '@/components/reader/audio-player-bar';
import { useAuth } from '@/lib/auth-context';
import { downloadMediaStore, readDownloadCatalog, type DownloadedTrack } from '@/lib/download-catalog';

interface LocalPlayback {
  player: PlaybackTransport | null;
  track: DownloadedTrack | null;
  playlistTitle: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  index: number;
  queueLength: number;
  playTracks: (ids: string[], index?: number, playlistTitle?: string) => Promise<void>;
  next: () => void;
  previous: () => void;
  stop: () => void;
}

const Context = createContext<LocalPlayback | null>(null);

export function OfflinePlaybackProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const sequence = useRef<string[]>([]);
  const sequenceIndex = useRef(0);
  const playlistName = useRef<string | null>(null);
  const loadRef = useRef<(index: number) => Promise<void>>(async () => {});
  const [track, setTrack] = useState<DownloadedTrack | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null);
  const [queueLength, setQueueLength] = useState(0);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.removeAttribute('src');
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    sequence.current = [];
    setQueueLength(0);
    setPlaylistTitle(null);
    setTrack(null);
    setPlaying(false);
    setPositionMs(0);
    setDurationMs(0);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    const onTime = () => setPositionMs(audio.currentTime * 1000);
    const onDuration = () => setDurationMs(Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      if (sequenceIndex.current + 1 < sequence.current.length) void loadRef.current(sequenceIndex.current + 1);
      else setPlaying(false);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => { audio.pause(); audio.removeAttribute('src'); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); audioRef.current = null; };
  }, []);

  const load = useCallback(async (nextIndex: number) => {
    if (!user || !audioRef.current) return;
    const id = sequence.current[nextIndex];
    if (!id) return;
    const media = await downloadMediaStore(user.uid).getTrack(id);
    if (!media) throw new Error('This download is missing from this device.');
    const catalog = await readDownloadCatalog(user.uid);
    const nextTrack = catalog.tracks[id];
    if (!nextTrack) throw new Error('This download is not in your library.');
    audioRef.current.pause();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(media.audioBlob);
    audioRef.current.src = objectUrl.current;
    sequenceIndex.current = nextIndex;
    setIndex(nextIndex);
    setTrack(nextTrack);
    setPositionMs(0);
    setDurationMs(nextTrack.durationMs);
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: nextTrack.title,
        artist: nextTrack.voice || 'mdmedia',
        album: playlistName.current || 'Downloads',
        artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
      });
    }
    await audioRef.current.play();
  }, [user]);
  useEffect(() => { loadRef.current = load; }, [load]);

  const playTracks = useCallback(async (ids: string[], startIndex = 0, title?: string) => {
    sequence.current = ids;
    playlistName.current = title || null;
    setQueueLength(ids.length);
    setPlaylistTitle(title || null);
    await load(startIndex);
  }, [load]);

  const next = useCallback(() => { void load(sequenceIndex.current + 1); }, [load]);
  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    void load(Math.max(0, sequenceIndex.current - 1));
  }, [load]);

  const player = useMemo<PlaybackTransport>(() => ({
    get rate() { return audioRef.current?.playbackRate ?? 1; },
    play: () => audioRef.current?.play(),
    pause: () => audioRef.current?.pause(),
    seek: (ms) => { if (audioRef.current) audioRef.current.currentTime = ms / 1000; },
    scrub: (ms) => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime + ms / 1000); },
    setRate: (rate) => { if (audioRef.current) audioRef.current.playbackRate = rate; },
    setVolume: (volume) => { if (audioRef.current) audioRef.current.volume = volume; },
  }), []);

  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void audioRef.current?.play(); },
      pause: () => audioRef.current?.pause(),
      stop: () => audioRef.current?.pause(),
      seekbackward: (detail) => player.scrub(-(detail.seekOffset ?? 10) * 1000),
      seekforward: (detail) => player.scrub((detail.seekOffset ?? 10) * 1000),
      seekto: (detail) => { if (detail.seekTime !== undefined) player.seek(detail.seekTime * 1000); },
      previoustrack: previous,
      nexttrack: next,
    };
    for (const [name, handler] of Object.entries(actions)) {
      try { session.setActionHandler(name as MediaSessionAction, handler); } catch { /* unsupported */ }
    }
    return () => { for (const name of Object.keys(actions)) { try { session.setActionHandler(name as MediaSessionAction, null); } catch { /* unsupported */ } } };
  }, [track, player, next, previous]);

  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    try { navigator.mediaSession.setPositionState({ duration: durationMs / 1000, position: Math.min(positionMs, durationMs) / 1000, playbackRate: player.rate }); } catch { /* unsupported */ }
  }, [track, playing, durationMs, positionMs, player]);

  const value = useMemo<LocalPlayback>(() => ({
    player: track ? player : null,
    track,
    playlistTitle,
    positionMs,
    durationMs,
    playing,
    index,
    queueLength,
    playTracks,
    next,
    previous,
    stop,
  }), [track, player, playlistTitle, positionMs, durationMs, playing, index, queueLength, playTracks, next, previous, stop]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useOfflinePlayback(): LocalPlayback {
  const value = useContext(Context);
  if (!value) throw new Error('Offline playback must be inside its provider.');
  return value;
}
