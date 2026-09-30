'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlaybackTransport } from '@/components/reader/audio-player-bar';
import { useAuth } from '@/lib/auth-context';
import type { DownloadedTrack } from '@/lib/download-catalog';
import { loadDownloadedTrack } from '@/lib/download-playback';

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
  const loadGeneration = useRef(0);
  const uidRef = useRef(user?.uid);
  uidRef.current = user?.uid;
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
    loadGeneration.current++;
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

  }, []);

  useEffect(() => { stop(); }, [user?.uid, stop]);

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
    return () => { loadGeneration.current++; audio.pause(); audio.removeAttribute('src'); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); audioRef.current = null; };
  }, []);

  const load = useCallback(async (nextIndex: number) => {
    if (!user || !audioRef.current) return;
    const id = sequence.current[nextIndex];
    if (!id) return;
    const audio = audioRef.current;
    const uid = user.uid;
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current && audioRef.current === audio && uidRef.current === uid;
    const saved = await loadDownloadedTrack(uid, id, current);
    if (!saved || !current()) return;
    const { media, track: nextTrack } = saved;
    audioRef.current.pause();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(media.audioBlob);
    audioRef.current.src = objectUrl.current;
    sequenceIndex.current = nextIndex;
    setIndex(nextIndex);
    setTrack(nextTrack);
    setPositionMs(0);
    setDurationMs(nextTrack.durationMs);
    await audio.play();
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
