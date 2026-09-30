'use client';

import { useEffect, useRef } from 'react';
import { connectMediaSession, type MediaPlayback } from './media-session';

export function useMediaSession(playback: MediaPlayback) {
  const connection = useRef<ReturnType<typeof connectMediaSession> | null>(null);
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    connection.current = connectMediaSession(navigator.mediaSession, (init) => new MediaMetadata(init));
    return () => { connection.current?.dispose(); connection.current = null; };
  }, []);
  const { player, title, artist, album, playing, durationMs, previous, next } = playback;
  const positionSecond = Math.floor(playback.positionMs / 1000);
  const rate = player?.rate;
  useEffect(() => {
    connection.current?.update({ player, title, artist, album, playing, durationMs, positionMs: positionSecond * 1000, previous, next });
  }, [player, title, artist, album, playing, durationMs, positionSecond, rate, previous, next]);
}
