import type { PlaybackTransport } from '../components/reader/audio-player-bar';

export interface MediaPlayback {
  player: PlaybackTransport | null;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  previous?: () => void;
  next?: () => void;
}

/** The shell owns this connection for its lifetime; transport changes keep its handlers. */
export function connectMediaSession(session: MediaSession, metadata: (init: MediaMetadataInit) => MediaMetadata) {
  let active: MediaPlayback | null = null;
  let metadataKey = '';
  const setAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try { session.setActionHandler(action, handler); } catch { /* Optional browser action. */ }
  };
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => { void active?.player?.play(); },
    pause: () => active?.player?.pause(),
    stop: () => active?.player?.pause(),
    seekbackward: (details) => active?.player?.scrub(-(details.seekOffset ?? 10) * 1000),
    seekforward: (details) => active?.player?.scrub((details.seekOffset ?? 10) * 1000),
    seekto: (details) => { if (details.seekTime !== undefined) active?.player?.seek(details.seekTime * 1000); },
  };
  for (const [action, handler] of Object.entries(handlers)) setAction(action as MediaSessionAction, handler!);
  return {
    update(next: MediaPlayback) {
      active = next;
      setAction('previoustrack', next.player && next.previous ? () => active?.previous?.() : null);
      setAction('nexttrack', next.player && next.next ? () => active?.next?.() : null);
      const key = next.player ? JSON.stringify([next.title, next.artist, next.album]) : '';
      if (key !== metadataKey) {
        session.metadata = key ? metadata({
          title: next.title, artist: next.artist, album: next.album,
          artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
        }) : null;
        metadataKey = key;
      }
      session.playbackState = next.player ? next.playing ? 'playing' : 'paused' : 'none';
      try {
        if (next.player && next.durationMs > 0) session.setPositionState({
          duration: next.durationMs / 1000,
          position: Math.max(0, Math.min(next.positionMs, next.durationMs)) / 1000,
          playbackRate: next.player.rate,
        });
        else session.setPositionState();
      } catch { /* Position state is optional. */ }
    },
    dispose() {
      active = null;
      for (const action of [...Object.keys(handlers), 'previoustrack', 'nexttrack']) setAction(action as MediaSessionAction, null);
      session.metadata = null;
      session.playbackState = 'none';
      try { session.setPositionState(); } catch { /* Optional browser feature. */ }
    },
  };
}
