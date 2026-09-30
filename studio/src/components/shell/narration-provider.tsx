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
  DEFAULT_HEADING_INSTRUCTIONS,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_SETTINGS,
  DEFAULT_TTS_MODEL,
  HIGHLIGHT_COLORS,
  type HighlightColorId,
  type Narration,
  type Playlist,
  type TTSModelName,
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
  model: TTSModelName;
  promptStyle: string;
  rewriteForNarration: boolean;
  rewriteInstructions?: string;
  structureMarkdown?: boolean;
  visibility: Visibility;
  speed?: number;
  verbalizeDiagrams?: boolean;
}

export interface PlaylistQueueState {
  playlistId: string;
  playlistTitle: string;
  tracks: Narration[];
  index: number;
}

export type DocumentView = "adapted" | "source" | "raw";

export function parseDocumentView(param: string | null | undefined): DocumentView {
  if (param === "source" || param === "raw" || param === "adapted") {
    return param;
  }
  return "adapted";
}

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
  setDocumentView: (view: DocumentView, options?: { updateUrl?: boolean }) => void;
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
  const [documentView, setDocumentViewState] = useState<DocumentView>(() => {
    if (typeof window !== "undefined") {
      const urlDoc = new URLSearchParams(window.location.search).get("doc");
      return parseDocumentView(urlDoc);
    }
    return "adapted";
  });
  const wasPlayingRef = useRef(false);
  const lastStreamIdRef = useRef(stream.id);

  const setDocumentView = useCallback(
    (view: DocumentView, options?: { updateUrl?: boolean }) => {
      setDocumentViewState(view);
      if (
        options?.updateUrl !== false &&
        typeof window !== "undefined" &&
        window.location.pathname.startsWith("/narration/")
      ) {
        const url = new URL(window.location.href);
        if (view === "adapted") {
          url.searchParams.delete("doc");
        } else {
          url.searchParams.set("doc", view);
        }
        window.history.replaceState(null, "", url.toString());
      }
    },
    [],
  );

  useEffect(() => {
    if (stream.id !== lastStreamIdRef.current) {
      lastStreamIdRef.current = stream.id;
      if (typeof window !== "undefined") {
        const urlDoc = new URLSearchParams(window.location.search).get("doc");
        if (urlDoc) {
          setDocumentViewState(parseDocumentView(urlDoc));
          return;
        }
      }
      setDocumentViewState("adapted");
    }
  }, [stream.id]);

  useEffect(() => {
    const handlePopState = () => {
      const urlDoc = new URLSearchParams(window.location.search).get("doc");
      setDocumentViewState(parseDocumentView(urlDoc));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
      model: DEFAULT_TTS_MODEL,
      promptStyle: settings.defaultPromptStyle,
      rewriteForNarration: settings.rewriteForNarration,
      rewriteInstructions: DEFAULT_HEADING_INSTRUCTIONS,
      visibility: settings.defaultVisibility,
      speed: 1.0,
      verbalizeDiagrams: false,
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

  const mediaControlsRef = useRef({
    player: stream.player,
    nextTrack,
    previousTrack,
  });
  useEffect(() => {
    mediaControlsRef.current = { player: stream.player, nextTrack, previousTrack };
  }, [stream.player, nextTrack, previousTrack]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void mediaControlsRef.current.player?.play(); },
      pause: () => { mediaControlsRef.current.player?.pause(); },
      stop: () => { mediaControlsRef.current.player?.pause(); },
      seekbackward: (details) => {
        mediaControlsRef.current.player?.scrub(-(details.seekOffset ?? 10) * 1000);
      },
      seekforward: (details) => {
        mediaControlsRef.current.player?.scrub((details.seekOffset ?? 10) * 1000);
      },
      seekto: (details) => {
        if (details.seekTime !== undefined) {
          mediaControlsRef.current.player?.seek(details.seekTime * 1000);
        }
      },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action as MediaSessionAction, handler);
      } catch {
        // Browsers may expose only a subset of Media Session actions.
      }
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          session.setActionHandler(action as MediaSessionAction, null);
        } catch {
          // The action was not supported when registered either.
        }
      }
      session.playbackState = "none";
      session.metadata = null;
    };
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.setActionHandler("previoustrack", queue
        ? () => { mediaControlsRef.current.previousTrack(); }
        : null);
      session.setActionHandler("nexttrack", queue && queue.index + 1 < queue.tracks.length
        ? () => { mediaControlsRef.current.nextTrack(); }
        : null);
    } catch {
      // Track controls are optional in some browsers.
    }
    return () => {
      try {
        session.setActionHandler("previoustrack", null);
        session.setActionHandler("nexttrack", null);
      } catch {
        // Track controls were not supported when registered either.
      }
    };
  }, [queue]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = stream.player
      ? new MediaMetadata({
          title: stream.title || "Narration",
          artist: stream.voice || "mdmedia",
          album: queue?.playlistTitle || "mdmedia studio",
          artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
        })
      : null;
  }, [stream.player, stream.title, stream.voice, queue?.playlistTitle]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = stream.player
      ? stream.playing ? "playing" : "paused"
      : "none";
  }, [stream.player, stream.playing]);

  const mediaPositionSecond = Math.floor(stream.positionMs / 1000);
  const mediaRate = stream.player?.rate ?? 1;
  useEffect(() => {
    if (!("mediaSession" in navigator) || !stream.player || stream.durationMs <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: stream.durationMs / 1000,
        playbackRate: mediaRate,
        position: Math.min(stream.player.positionMs, stream.durationMs) / 1000,
      });
    } catch {
      // Some browsers do not implement position state.
    }
  }, [stream.player, stream.durationMs, mediaPositionSecond, mediaRate, stream.playing]);

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
