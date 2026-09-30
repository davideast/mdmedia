import { describe, expect, it } from 'bun:test';
import { connectMediaSession, type MediaPlayback } from '../../studio/src/lib/media-session';

describe('one Media Session connection across playback handoffs', () => {
  it('moves lock screen controls from downloads to online playback and back', () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const session = {
      metadata: null,
      playbackState: 'none',
      setActionHandler: (action: string, handler: MediaSessionActionHandler | null) => { handlers.set(action, handler); },
      setPositionState: () => {},
    } as unknown as MediaSession;
    const calls: string[] = [];
    const track = (name: string): MediaPlayback => ({
      title: name, artist: 'Reader', album: 'Playlist', playing: true, positionMs: 1000, durationMs: 5000,
      player: { rate: 1, play: () => { calls.push(`${name}:play`); }, pause: () => { calls.push(`${name}:pause`); },
        seek: (ms) => { calls.push(`${name}:seek:${ms}`); }, scrub: () => {}, setRate: () => {}, setVolume: () => {} },
      next: () => { calls.push(`${name}:next`); },
    });
    const connection = connectMediaSession(session, (init) => init as MediaMetadata);
    for (const name of ['download', 'online', 'download']) {
      connection.update(track(name));
      handlers.get('play')?.({ action: 'play' });
      handlers.get('pause')?.({ action: 'pause' });
      handlers.get('seekto')?.({ action: 'seekto', seekTime: 2 });
      handlers.get('nexttrack')?.({ action: 'nexttrack' });
      expect(session.metadata?.title).toBe(name);
      expect(session.playbackState).toBe('playing');
    }
    expect(calls).toEqual(['download', 'online', 'download'].flatMap((name) => [
      `${name}:play`, `${name}:pause`, `${name}:seek:2000`, `${name}:next`,
    ]));
    connection.update({ ...track('last'), next: undefined, previous: undefined });
    expect(handlers.get('nexttrack')).toBeNull();
    connection.dispose();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
  });
});
