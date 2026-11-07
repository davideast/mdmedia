"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalNarration } from "@/components/shell/narration-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import type { ChatNarrationStreamEvent } from "@/lib/chat/types";
import { auth } from "@/lib/firebase";
import { StreamingPcmPlayer, unlockPlaybackAudio } from "@/lib/pcm-player";
import type { TranscriptSourceMap } from "@/lib/tree-types";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  type AlignedChunk,
  type AlignedWord,
  type HighlightColorId,
} from "@/lib/types";
import type { ChatMarkdownNarrationState } from "./chat-markdown";

const MAX_CACHED_MESSAGES = 10;

interface CachedChatNarration {
  pcmParts: Uint8Array[];
  chunks: AlignedChunk[];
  transcript: string;
  sourceMap?: TranscriptSourceMap;
  durationMs: number;
}

function decodeBase64Pcm(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Binary search over flattened `AlignedWord[]` to find the active word under
 * `positionMs`, holding across natural inter-word micro-pauses (<= 250ms).
 */
export function findActiveChatNarrationWord(
  words: readonly AlignedWord[],
  positionMs: number,
): { charStart: number; charEnd: number } | null {
  if (words.length === 0) return null;
  let low = 0;
  let high = words.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid]!.startMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) return null;
  const word = words[candidate]!;
  if (positionMs <= word.endMs) {
    return { charStart: word.charStart, charEnd: word.charEnd };
  }

  const nextWord = words[candidate + 1];
  if (
    nextWord &&
    positionMs < nextWord.startMs &&
    nextWord.startMs - word.endMs <= 250
  ) {
    return { charStart: word.charStart, charEnd: word.charEnd };
  }

  return null;
}

export type ChatMessageNarrationStatus =
  | "idle"
  | "starting"
  | "streaming"
  | "ready"
  | "error";

export interface UseChatMessageNarrationResult {
  activeMessageId: string | null;
  status: ChatMessageNarrationStatus;
  errorMessage: string | null;
  isMessagePlaying: (messageId: string) => boolean;
  toggleMessage: (messageId: string, markdown: string) => void;
  seekWord: (messageId: string, markdown: string, startMs: number) => void;
  getNarrationForMessage: (
    messageId: string,
    markdown: string,
  ) => ChatMarkdownNarrationState | null;
}

export function useChatMessageNarration(
  activeThreadId: string | null,
): UseChatMessageNarrationResult {
  const narrationCtx = useOptionalNarration();
  const authCtx = useOptionalAuth();
  const highlightColor: HighlightColorId =
    narrationCtx?.highlightColor ??
    authCtx?.profile?.settings?.highlightColor ??
    DEFAULT_HIGHLIGHT_COLOR;

  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [status, setStatus] = useState<ChatMessageNarrationStatus>("idle");
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [loadedDurationMs, setLoadedDurationMs] = useState(0);
  const [chunks, setChunks] = useState<AlignedChunk[]>([]);
  const [sourceMap, setSourceMap] = useState<TranscriptSourceMap | undefined>(
    undefined,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const playerRef = useRef<StreamingPcmPlayer | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionTokenRef = useRef(0);
  const autoPlayDesiredRef = useRef(false);
  const cacheRef = useRef<Map<string, CachedChatNarration>>(new Map());

  const teardownActiveSession = useCallback(() => {
    sessionTokenRef.current += 1;
    autoPlayDesiredRef.current = false;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
  }, []);

  const resetToIdle = useCallback(() => {
    teardownActiveSession();
    setActiveMessageId(null);
    setStatus("idle");
    setPlaying(false);
    setEnded(false);
    setPositionMs(0);
    setLoadedDurationMs(0);
    setChunks([]);
    setSourceMap(undefined);
  }, [teardownActiveSession]);

  // Stop playback and release WebAudio resources on thread switch or unmount.
  useEffect(() => {
    resetToIdle();
  }, [activeThreadId, resetToIdle]);

  // Mutual pause: if global Studio narration starts playing, pause chat playback.
  const globalNarrationPlaying = narrationCtx?.stream.playing ?? false;
  useEffect(() => {
    if (globalNarrationPlaying && playerRef.current) {
      autoPlayDesiredRef.current = false;
      playerRef.current.pause();
    }
  }, [globalNarrationPlaying]);

  const pauseGlobalNarrationIfPlaying = useCallback(() => {
    if (narrationCtx?.stream.playing) {
      narrationCtx.stream.player?.pause();
    }
  }, [narrationCtx]);

  const storeInCache = useCallback(
    (cacheKey: string, entry: CachedChatNarration) => {
      const map = cacheRef.current;
      map.delete(cacheKey);
      map.set(cacheKey, entry);
      while (map.size > MAX_CACHED_MESSAGES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    [],
  );

  const attachPlayerListeners = useCallback(
    (player: StreamingPcmPlayer, token: number) => {
      player.subscribe((st) => {
        if (sessionTokenRef.current !== token) return;
        setPositionMs(st.positionMs);
        setLoadedDurationMs(st.durationMs);
        setPlaying(st.playing);
      });
      player.onEnded(() => {
        if (sessionTokenRef.current !== token) return;
        autoPlayDesiredRef.current = false;
        setPlaying(false);
        setEnded(true);
      });
    },
    [],
  );

  const startMessageNarration = useCallback(
    async (
      messageId: string,
      markdown: string,
      initialSeekMs?: number,
    ): Promise<void> => {
      const trimmed = markdown.trim();
      if (!trimmed) return;

      teardownActiveSession();
      pauseGlobalNarrationIfPlaying();

      const token = sessionTokenRef.current;
      const cacheKey = `${messageId}::${trimmed}`;
      const cached = cacheRef.current.get(cacheKey);

      setErrorMessage(null);
      setActiveMessageId(messageId);
      setEnded(false);
      autoPlayDesiredRef.current = true;

      if (cached) {
        // Refresh MRU order
        storeInCache(cacheKey, cached);
        const player = new StreamingPcmPlayer();
        playerRef.current = player;
        attachPlayerListeners(player, token);
        for (const part of cached.pcmParts) {
          player.append(part);
        }
        player.completeStream();

        setChunks(cached.chunks);
        setSourceMap(cached.sourceMap);
        setLoadedDurationMs(cached.durationMs);
        setPositionMs(initialSeekMs ?? 0);
        setStatus("ready");
        setPlaying(true);

        if (typeof initialSeekMs === "number" && initialSeekMs > 0) {
          player.seek(initialSeekMs);
        }
        await player.play();
        return;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const player = new StreamingPcmPlayer();
      playerRef.current = player;
      attachPlayerListeners(player, token);

      setStatus("starting");
      setPlaying(true);
      setPositionMs(0);
      setLoadedDurationMs(0);
      setChunks([]);
      setSourceMap(undefined);

      const collectedPcmParts: Uint8Array[] = [];
      const collectedChunks: AlignedChunk[] = [];
      let collectedTranscript = "";
      let collectedSourceMap: TranscriptSourceMap | undefined;
      let startedPlayback = false;

      try {
        const idToken = await auth().currentUser?.getIdToken();
        if (sessionTokenRef.current !== token || controller.signal.aborted) {
          return;
        }
        if (!idToken) {
          throw new Error("Please sign in to Studio to narrate messages.");
        }

        const response = await fetch("/api/v1/chat/narrate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ markdown: trimmed }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const errPayload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
            message?: string;
          } | null;
          throw new Error(
            errPayload?.error?.message ??
              errPayload?.message ??
              "Could not narrate this message.",
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handleLine = (line: string) => {
          const clean = line.trim();
          if (!clean) return;
          const event = JSON.parse(clean) as ChatNarrationStreamEvent;

          if (event.type === "transcript") {
            collectedTranscript = event.transcript;
            collectedSourceMap = event.sourceMap;
            setSourceMap(event.sourceMap);
            return;
          }

          if (event.type === "audio") {
            const bytes = decodeBase64Pcm(event.pcm);
            if (bytes.byteLength === 0) return;
            collectedPcmParts.push(bytes);
            player.append(bytes);
            setStatus("streaming");

            if (!startedPlayback && autoPlayDesiredRef.current) {
              startedPlayback = true;
              if (typeof initialSeekMs === "number" && initialSeekMs > 0) {
                player.seek(initialSeekMs);
              }
              void player.play();
            }
            return;
          }

          if (event.type === "chunk") {
            const nextChunk: AlignedChunk = {
              index: event.chunk.index,
              startMs: event.chunk.startMs,
              endMs: event.chunk.endMs,
              docOffset: event.chunk.docOffset,
              text: event.chunk.text,
              words: event.chunk.words.map((w) => ({ ...w })),
            };
            collectedChunks.push(nextChunk);
            setChunks((prev) => [...prev, nextChunk]);
            return;
          }

          if (event.type === "done") {
            player.completeStream();
            setStatus("ready");
            if (collectedPcmParts.length > 0 && collectedChunks.length > 0) {
              storeInCache(cacheKey, {
                pcmParts: collectedPcmParts,
                chunks: collectedChunks,
                transcript: collectedTranscript,
                sourceMap: collectedSourceMap,
                durationMs: event.durationMs,
              });
            }
            return;
          }

          if (event.type === "error") {
            throw new Error(event.message || "Could not narrate this message.");
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (sessionTokenRef.current !== token || controller.signal.aborted) {
            return;
          }
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIdx = buffer.indexOf("\n");
          while (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            handleLine(line);
            newlineIdx = buffer.indexOf("\n");
          }
        }

        const trailing = (buffer + decoder.decode()).trim();
        if (trailing && sessionTokenRef.current === token) {
          handleLine(trailing);
        }
      } catch (error) {
        if (sessionTokenRef.current !== token || controller.signal.aborted) {
          return;
        }
        player.destroy();
        if (playerRef.current === player) {
          playerRef.current = null;
        }
        autoPlayDesiredRef.current = false;
        setPlaying(false);
        setStatus("error");
        setActiveMessageId(null);
        setChunks([]);
        setSourceMap(undefined);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Could not narrate this message.",
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    },
    [
      attachPlayerListeners,
      pauseGlobalNarrationIfPlaying,
      storeInCache,
      teardownActiveSession,
    ],
  );

  const toggleMessage = useCallback(
    (messageId: string, markdown: string) => {
      unlockPlaybackAudio();
      if (activeMessageId === messageId) {
        if (status === "starting" && loadedDurationMs === 0) {
          // Cancel before first audio frame arrived -> un-dim cleanly
          resetToIdle();
          return;
        }
        if (playing) {
          autoPlayDesiredRef.current = false;
          playerRef.current?.pause();
          setPlaying(false);
          return;
        }
        if (playerRef.current) {
          pauseGlobalNarrationIfPlaying();
          autoPlayDesiredRef.current = true;
          setEnded(false);
          setPlaying(true);
          void playerRef.current.play();
          return;
        }
      }
      void startMessageNarration(messageId, markdown);
    },
    [
      activeMessageId,
      loadedDurationMs,
      pauseGlobalNarrationIfPlaying,
      playing,
      resetToIdle,
      startMessageNarration,
      status,
    ],
  );

  const seekWord = useCallback(
    (messageId: string, markdown: string, startMs: number) => {
      unlockPlaybackAudio();
      pauseGlobalNarrationIfPlaying();

      if (activeMessageId === messageId && playerRef.current) {
        autoPlayDesiredRef.current = true;
        setEnded(false);
        playerRef.current.seek(startMs);
        setPositionMs(startMs);
        if (!playing) {
          setPlaying(true);
          void playerRef.current.play();
        }
        return;
      }

      void startMessageNarration(messageId, markdown, startMs);
    },
    [
      activeMessageId,
      pauseGlobalNarrationIfPlaying,
      playing,
      startMessageNarration,
    ],
  );

  const words = useMemo(
    () => chunks.flatMap((chunk) => chunk.words),
    [chunks],
  );

  const activeWord = useMemo(() => {
    if (ended) return null;
    if (!playing && positionMs <= 0) return null;
    return findActiveChatNarrationWord(words, positionMs);
  }, [ended, playing, positionMs, words]);

  const isMessagePlaying = useCallback(
    (messageId: string): boolean => {
      if (activeMessageId !== messageId) return false;
      if (status === "starting") return true;
      return playing;
    },
    [activeMessageId, playing, status],
  );

  const getNarrationForMessage = useCallback(
    (
      messageId: string,
      markdown: string,
    ): ChatMarkdownNarrationState | null => {
      if (activeMessageId !== messageId) return null;
      if (status === "idle" || status === "error") return null;

      return {
        active:
          status === "starting" ||
          status === "streaming" ||
          playing ||
          !ended,
        chunks,
        words,
        sourceMap,
        audioLoaded: loadedDurationMs > 0 || words.length > 0,
        loadedDurationMs,
        activeCharStart: activeWord?.charStart ?? null,
        activeCharEnd: activeWord?.charEnd ?? null,
        highlightColor,
        onSeekWord: (startMs: number) => seekWord(messageId, markdown, startMs),
      };
    },
    [
      activeMessageId,
      activeWord,
      chunks,
      ended,
      highlightColor,
      loadedDurationMs,
      playing,
      seekWord,
      sourceMap,
      status,
      words,
    ],
  );

  return {
    activeMessageId,
    status,
    errorMessage,
    isMessagePlaying,
    toggleMessage,
    seekWord,
    getNarrationForMessage,
  };
}
