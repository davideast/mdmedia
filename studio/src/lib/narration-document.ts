import type { Narration } from './types';
import type { NarrationTimingsFile } from './wav';

export interface NarrationDocument {
  id: string;
  title: string;
  voice: string | null;
  transcript: string;
  sourceMarkdown: string | null;
  adapted: boolean;
  chunks: NarrationTimingsFile['chunks'];
  status: 'loading' | 'streaming' | 'ready' | 'error';
  errorMessage: string | null;
}

export interface PlaybackSlice<TPlayer = unknown> {
  id: string | null;
  title: string;
  voice: string | null;
  transcript: string;
  sourceMarkdown: string | null;
  adapted: boolean;
  chunks: NarrationTimingsFile['chunks'];
  status: 'idle' | 'loading' | 'starting' | 'streaming' | 'ready' | 'error';
  errorMessage: string | null;
  player: TPlayer | null;
  playing: boolean;
  activeWord: { charStart: number; charEnd: number } | null;
  durationMs: number;
  positionMs: number;
}

export interface NarrationViewProjection<TPlayer = unknown> {
  id: string;
  title: string;
  voice: string | null;
  transcript: string;
  sourceMarkdown: string | null;
  adapted: boolean;
  chunks: NarrationTimingsFile['chunks'];
  status: 'idle' | 'loading' | 'starting' | 'streaming' | 'ready' | 'error';
  errorMessage: string | null;
  player: TPlayer | null;
  playing: boolean;
  activeWord: { charStart: number; charEnd: number } | null;
  durationMs: number;
  positionMs: number;
}

/**
 * Projects a narration view by combining the independent document observer with
 * the active playback stream when matching `id`. Preserves loaded document text,
 * title, and word timings while playback is still initializing its audio player
 * so pressing Play never flickers or unmounts the reader.
 */
export function projectNarrationView<TPlayer = unknown>(
  id: string,
  document: NarrationDocument | null,
  playback: PlaybackSlice<TPlayer>,
): NarrationViewProjection<TPlayer> {
  const isLive = playback.id === id;
  if (!isLive) {
    return {
      id,
      title: document?.title ?? '',
      voice: document?.voice ?? null,
      transcript: document?.transcript ?? '',
      sourceMarkdown: document?.sourceMarkdown ?? null,
      adapted: document?.adapted ?? false,
      chunks: document?.chunks ?? [],
      status: document?.status ?? 'loading',
      errorMessage: document?.errorMessage ?? null,
      player: null,
      playing: false,
      activeWord: null,
      durationMs: 0,
      positionMs: 0,
    };
  }

  const docChunks = document?.chunks ?? [];
  const chunks =
    playback.chunks.length >= docChunks.length ? playback.chunks : docChunks;
  const status =
    playback.status === 'error' || document?.status === 'error'
      ? 'error'
      : playback.status === 'loading' && document && document.status !== 'loading'
        ? document.status
        : playback.status;

  return {
    id,
    title: playback.title || document?.title || '',
    voice: playback.voice ?? document?.voice ?? null,
    transcript: playback.transcript || document?.transcript || '',
    sourceMarkdown: playback.sourceMarkdown ?? document?.sourceMarkdown ?? null,
    adapted: playback.adapted || (document?.adapted ?? false),
    chunks,
    status,
    errorMessage: playback.errorMessage ?? document?.errorMessage ?? null,
    player: playback.player,
    playing: playback.playing,
    activeWord: playback.activeWord,
    durationMs: playback.durationMs,
    positionMs: playback.positionMs,
  };
}

/**
 * Only display the bottom floating player bar when an offline track or an online
 * player with non-zero audio duration is actually loaded and interactive.
 */
export function shouldShowPlayerBar(input: {
  hasOfflineTrack: boolean;
  player: unknown | null;
  durationMs: number;
  /** A narration's audio was requested and has not started; the bar acknowledges Play. */
  loadingAudio?: boolean;
}): boolean {
  return input.hasOfflineTrack || input.loadingAudio === true || (input.player !== null && input.durationMs > 0);
}

interface DocumentSource {
  watch: (id: string, receive: (narration: Narration | null) => void, fail: (error: Error) => void) => () => void;
  timings: (id: string, signal: AbortSignal) => Promise<NarrationTimingsFile | null>;
}

/** Reads a document and alignment checkpoints. It has no audio/player dependency. */
export function observeNarrationDocument(id: string, source: DocumentSource, receive: (document: NarrationDocument) => void): () => void {
  const controller = new AbortController();
  let document: NarrationDocument = { id, title: '', voice: null, transcript: '', sourceMarkdown: null, adapted: false,
    chunks: [], status: 'loading', errorMessage: null };
  let checkpoint = '';
  let revision = 0;
  const publish = () => { if (!controller.signal.aborted) receive(document); };
  publish();
  const unsubscribe = source.watch(id, (narration) => {
    if (controller.signal.aborted) return;
    if (!narration) {
      revision++;
      document = { ...document, chunks: [], transcript: '', sourceMarkdown: null, status: 'error', errorMessage: "That narration isn't available." };
      publish();
      return;
    }
    document = { ...document, title: narration.title, voice: narration.voice, transcript: narration.transcript,
      sourceMarkdown: narration.sourceMarkdown, adapted: narration.adapted, status: narration.status,
      errorMessage: narration.errorMessage ?? null };
    publish();
    const nextCheckpoint = `${narration.status}:${narration.durationMs}`;
    if (checkpoint === nextCheckpoint || narration.status === 'error' || !narration.durationMs) return;
    checkpoint = nextCheckpoint;
    const request = ++revision;
    void source.timings(id, controller.signal).then((timings) => {
      if (controller.signal.aborted || request !== revision || !timings) return;
      document = { ...document, chunks: [...timings.chunks].sort((a, b) => a.index - b.index),
        transcript: document.transcript || timings.transcript || '',
        sourceMarkdown: document.sourceMarkdown ?? timings.sourceMarkdown ?? null };
      publish();
    }).catch(() => {
      // Text remains readable if a checkpoint is unavailable. Playback reports audio errors separately.
    });
  }, (error) => {
    revision++;
    document = { ...document, chunks: [], transcript: '', sourceMarkdown: null, status: 'error', errorMessage: error.message || 'Could not load this narration.' };
    publish();
  });
  return () => { controller.abort(); unsubscribe(); };
}
