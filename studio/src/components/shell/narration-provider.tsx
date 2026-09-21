"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useNarrationStream } from "@/lib/use-narration-stream";
import type { NarrationStreamState } from "@/lib/use-narration-stream";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_SETTINGS,
  HIGHLIGHT_COLORS,
  type HighlightColorId,
  type Narration,
  type Playlist,
  type VoiceName,
  type Visibility,
} from "@/lib/types";
import { useAuth } from "@/lib/auth-context";

const HIGHLIGHT_STORAGE_KEY = "mdmedia.highlightColor";

import { useGenerationQueue } from "@/lib/use-generation-queue";
import type { GenerationJob, GenerationQueueState } from "@/lib/use-generation-queue";

export type { GenerationJob, GenerationQueueState };

export interface Draft {
  markdown: string;
  voice: VoiceName;
  promptStyle: string;
  rewriteForNarration: boolean;
  visibility: Visibility;
}

export interface PlaylistQueueState {
  playlistId: string;
  playlistTitle: string;
  tracks: Narration[];
  index: number;
}

export type DocumentView = "adapted" | "source";

interface NarrationContextValue {
  stream: NarrationStreamState;
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  resetDraft: () => void;
  highlightColor: HighlightColorId;
  setHighlightColor: (color: HighlightColorId) => void;
  queue: PlaylistQueueState | null;
  playPlaylist: (playlist: Playlist, tracks: Narration[], startIndex?: number) => void;
  playTrack: (narration: Narration) => void;
  nextTrack: () => void;
  previousTrack: () => void;
  documentView: DocumentView;
  setDocumentView: (view: DocumentView) => void;
  generationQueue: GenerationQueueState;
}

const NarrationContext = createContext<NarrationContextValue | null>(null);

/**
 * Holds the one live narration stream and active playlist queue for the whole
 * application.
 */
export function NarrationProvider({ children }: { children: ReactNode }) {
  const stream = useNarrationStream();
  const generationQueue = useGenerationQueue();
  const { user, profile, updateSettings } = useAuth();

  const settings = profile?.settings ?? DEFAULT_SETTINGS;

  const [overrides, setOverrides] = useState<Partial<Draft>>({});
  const [highlightColorOverride, setHighlightColorOverride] = useState<HighlightColorId | null>(
    null,
  );
  const [queue, setQueue] = useState<PlaylistQueueState | null>(null);
  const [documentView, setDocumentView] = useState<DocumentView>("adapted");
  const wasPlayingRef = useRef(false);
  const lastStreamIdRef = useRef(stream.id);

  useEffect(() => {
    if (stream.id !== lastStreamIdRef.current) {
      lastStreamIdRef.current = stream.id;
      setDocumentView("adapted");
    }
  }, [stream.id]);

  useEffect(() => {
    const stored = window.localStorage.getItem(HIGHLIGHT_STORAGE_KEY);
    if (stored && HIGHLIGHT_COLORS.some((item) => item.id === stored)) {
      setHighlightColorOverride(stored as HighlightColorId);
    }
  }, []);

  const highlightColor: HighlightColorId =
    highlightColorOverride ?? profile?.settings.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR;

  const setHighlightColor = useCallback(
    (color: HighlightColorId) => {
      setHighlightColorOverride(color);
      window.localStorage.setItem(HIGHLIGHT_STORAGE_KEY, color);
      if (user) {
        void updateSettings({ highlightColor: color }).catch(() => {});
      }
    },
    [user, updateSettings],
  );

  const draft = useMemo<Draft>(
    () => ({
      markdown: "",
      voice: settings.defaultVoice,
      promptStyle: settings.defaultPromptStyle,
      rewriteForNarration: settings.rewriteForNarration,
      visibility: settings.defaultVisibility,
      ...overrides,
    }),
    [settings, overrides],
  );

  const setDraft = useCallback((patch: Partial<Draft>) => {
    setOverrides((previous) => ({ ...previous, ...patch }));
  }, []);

  const resetDraft = useCallback(() => {
    setOverrides({});
  }, []);

  const playPlaylist = useCallback(
    (playlist: Playlist, tracks: Narration[], startIndex = 0) => {
      if (tracks.length === 0) return;
      const safeIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
      const target = tracks[safeIndex];
      setQueue({
        playlistId: playlist.id,
        playlistTitle: playlist.title,
        tracks,
        index: safeIndex,
      });
      void stream.loadExisting(target.id, { autoPlay: true });
    },
    [stream],
  );

  const playTrack = useCallback(
    (narration: Narration) => {
      setQueue(null);
      void stream.loadExisting(narration.id, { autoPlay: true });
    },
    [stream],
  );

  const nextTrack = useCallback(() => {
    if (queue === null) return;
    const nextIndex = queue.index + 1;
    if (nextIndex >= queue.tracks.length) return;
    const target = queue.tracks[nextIndex];
    setQueue((previous) => (previous ? { ...previous, index: nextIndex } : null));
    void stream.loadExisting(target.id, { autoPlay: true });
  }, [queue, stream]);

  const previousTrack = useCallback(() => {
    if (stream.player && stream.positionMs > 3_000) {
      stream.player.seek(0);
      return;
    }
    if (queue === null) {
      stream.player?.seek(0);
      return;
    }
    const prevIndex = queue.index - 1;
    if (prevIndex < 0) {
      stream.player?.seek(0);
      return;
    }
    const target = queue.tracks[prevIndex];
    setQueue((previous) => (previous ? { ...previous, index: prevIndex } : null));
    void stream.loadExisting(target.id, { autoPlay: true });
  }, [queue, stream]);

  // Auto-advance to the next track in the playlist when playback reaches the end.
  useEffect(() => {
    const justEnded =
      wasPlayingRef.current &&
      !stream.playing &&
      stream.status === "ready" &&
      stream.durationMs > 0 &&
      stream.positionMs >= stream.durationMs - 150;

    wasPlayingRef.current = stream.playing;

    if (justEnded && queue !== null && queue.index + 1 < queue.tracks.length) {
      nextTrack();
    }
  }, [stream.playing, stream.status, stream.durationMs, stream.positionMs, queue, nextTrack]);

  const value = useMemo(
    () => ({
      stream,
      draft,
      setDraft,
      resetDraft,
      highlightColor,
      setHighlightColor,
      queue,
      playPlaylist,
      playTrack,
      nextTrack,
      previousTrack,
      documentView,
      setDocumentView,
      generationQueue,
    }),
    [
      stream,
      draft,
      setDraft,
      resetDraft,
      highlightColor,
      setHighlightColor,
      queue,
      playPlaylist,
      playTrack,
      nextTrack,
      previousTrack,
      documentView,
      setDocumentView,
      generationQueue,
    ],
  );

  return (
    <NarrationContext.Provider value={value}>{children}</NarrationContext.Provider>
  );
}

export function useNarration(): NarrationContextValue {
  const value = useContext(NarrationContext);
  if (value === null) {
    throw new Error("useNarration must be used inside NarrationProvider");
  }
  return value;
}
