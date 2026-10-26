'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNarration } from '@/components/shell/narration-provider';
import { useAuth } from './auth-context';
import { studioJson } from './media-client';
import { unlockPlaybackAudio } from './pcm-player';
import { DEFAULT_TTS_MODEL } from './types';

type Segment = { id: string; text: string };
type Selection = { source: string; narrationId: string; segments: Segment[] };

/** Storyboard playback uses the application's single narration transport. */
export function useStoryboardNarration(storyboardId: string) {
  const { stream, playNarration, draft } = useNarration();
  const { profile } = useAuth();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const activeId = useRef<string | null>(null);
  const transport = useRef(stream);
  useEffect(() => { transport.current = stream; }, [stream]);

  const stop = useCallback(() => {
    epoch.current++;
    if (activeId.current && transport.current.id === activeId.current) transport.current.cancel();
    activeId.current = null;
    setSelection(null); setPending(null);
  }, []);
  useEffect(() => () => {
    epoch.current++;
    if (activeId.current && transport.current.id === activeId.current) transport.current.cancel();
  }, []);

  async function read(source: string, input: Segment[]) {
    const segments = input.filter(segment => segment.text.trim());
    if (!segments.length || pending) return;
    unlockPlaybackAudio();
    if (selection?.source === source && stream.id === selection.narrationId && stream.player && stream.status !== 'error') {
      if (stream.playing) stream.player.pause();
      else {
        if (stream.positionMs >= stream.durationMs) stream.player.seek(0);
        await stream.player.play();
      }
      return;
    }
    const request = ++epoch.current;
    stream.player?.pause();
    setPending(source); setError(null); setSelection(null);
    try {
      const result = await studioJson<{ id: string }>(`/api/v1/storyboards/${encodeURIComponent(storyboardId)}/narration`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: segments.map(segment => segment.text.trim()).join('\n\n'),
          voice: draft.voice.name, voiceProvider: draft.voice.provider, voiceId: draft.voice.id,
          model: profile?.settings.defaultGeminiModel ?? DEFAULT_TTS_MODEL,
          promptStyle: draft.promptStyle, speed: draft.speed ?? 1,
        }),
      });
      if (epoch.current !== request) return;
      activeId.current = result.id;
      setSelection({ source, narrationId: result.id, segments });
      playNarration(result.id, 0);
    } catch (cause) {
      if (epoch.current === request) setError((cause as Error).message);
    } finally {
      if (epoch.current === request) setPending(null);
    }
  }

  const ownsStream = selection !== null && stream.id === selection.narrationId;
  const loading = pending !== null || (ownsStream && ['loading', 'starting'].includes(stream.status));
  let beatId: string | null = null;
  if (ownsStream) {
    let offset = 0;
    for (const segment of selection.segments) {
      beatId = segment.id;
      offset += segment.text.trim().length + 2;
      if ((stream.activeWord?.charStart ?? 0) < offset) break;
    }
  }
  const status = loading ? 'loading' : ownsStream && stream.status !== 'error' ? stream.playing ? 'playing' : 'paused' : 'idle';
  return { read, stop, reading: {
    source: pending ?? (ownsStream ? selection.source : null), status, beatId,
    error: error ?? (ownsStream ? stream.errorMessage : null),
  } };
}
