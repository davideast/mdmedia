'use client';

/**
 * The client half of the narration engine.
 *
 * `start` opens the generation stream and feeds audio into the player as it
 * arrives; `loadExisting` replays a finished narration from Storage. Either
 * way the hook exposes one transport state plus the word the playhead is
 * currently on.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { auth } from './firebase';
import { watchNarration } from './narrations';
import { getMediaStore } from './media-store';
import { StreamingPcmPlayer } from './pcm-player';
import type { AlignedChunk, AlignedWord, StreamEvent, Visibility, VoiceName } from './types';
import type { NarrationTimingsFile } from './wav';

export interface NarrationStreamState {
  id: string | null;
  title: string;
  setTitle: (title: string) => void;
  voice: VoiceName | null;
  transcript: string;
  chunks: AlignedChunk[];
  status: 'idle' | 'loading' | 'starting' | 'streaming' | 'ready' | 'error';
  errorMessage: string | null;
  player: StreamingPcmPlayer | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  activeWord: { charStart: number; charEnd: number } | null;
  sourceMarkdown: string | null;
  adapted: boolean;
  start: (input: {
    markdown: string;
    voice: VoiceName;
    promptStyle: string;
    rewriteForNarration: boolean;
    visibility: Visibility;
  }) => Promise<void>;
  loadExisting: (id: string, options?: { autoPlay?: boolean }) => Promise<void>;
  cancel: () => void;
}

interface Transport {
  positionMs: number;
  durationMs: number;
  playing: boolean;
}

const IDLE_TRANSPORT: Transport = { positionMs: 0, durationMs: 0, playing: false };

const SIGN_IN_REQUIRED = 'Please sign in to create a narration.';
const GENERIC_FAILURE = 'Something went wrong while creating this narration. Please try again.';
const LOAD_FAILURE = "That narration isn't available.";

function decodeBase64Pcm(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Finds the word under the playhead. This runs on every animation frame, so it
 * is a binary search over the flattened word list rather than a scan.
 */
function findActiveWord(
  words: AlignedWord[],
  positionMs: number,
): { charStart: number; charEnd: number } | null {
  let low = 0;
  let high = words.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].startMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) return null;
  const word = words[candidate];
  if (positionMs <= word.endMs) {
    return { charStart: word.charStart, charEnd: word.charEnd };
  }

  // Gracefully hold highlight across normal inter-word micro-pauses (<= 250ms)
  const nextWord = words[candidate + 1];
  if (nextWord && positionMs < nextWord.startMs && nextWord.startMs - word.endMs <= 250) {
    return { charStart: word.charStart, charEnd: word.charEnd };
  }

  return null;
}

async function currentIdToken(): Promise<string | null> {
  const user = auth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

async function readMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : fallback;
  } catch {
    return fallback;
  }
}

export function useNarrationStream(): NarrationStreamState {
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [voice, setVoice] = useState<VoiceName | null>(null);
  const [transcript, setTranscript] = useState('');
  const [chunks, setChunks] = useState<AlignedChunk[]>([]);
  const [sourceMarkdown, setSourceMarkdown] = useState<string | null>(null);
  const [adapted, setAdapted] = useState<boolean>(false);
  const [status, setStatus] = useState<NarrationStreamState['status']>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [player, setPlayer] = useState<StreamingPcmPlayer | null>(null);
  const [transport, setTransport] = useState<Transport>(IDLE_TRANSPORT);
  const [, startNonUrgent] = useTransition();

  const playerRef = useRef<StreamingPcmPlayer | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const docUnsubRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadSessionRef = useRef(0);

  const ensurePlayer = useCallback((): StreamingPcmPlayer => {
    const existing = playerRef.current;
    if (existing) return existing;

    const created = new StreamingPcmPlayer();
    unsubscribeRef.current = created.subscribe((state) => {
      setTransport({
        positionMs: state.positionMs,
        durationMs: state.durationMs,
        playing: state.playing,
      });
    });
    playerRef.current = created;
    setPlayer(created);
    return created;
  }, []);

  const resetPlayer = useCallback(() => {
    loadSessionRef.current++;
    docUnsubRef.current?.();
    docUnsubRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    playerRef.current?.destroy();
    playerRef.current = null;
    setPlayer(null);
    setTransport(IDLE_TRANSPORT);
  }, []);

  useEffect(
    () => () => {
      loadSessionRef.current++;
      abortRef.current?.abort();
      docUnsubRef.current?.();
      docUnsubRef.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      playerRef.current?.destroy();
    },
    [],
  );

  const start = useCallback<NarrationStreamState['start']>(
    async (input) => {
      abortRef.current?.abort();
      resetPlayer();

      setId(null);
      setTitle('');
      setVoice(input.voice);
      setTranscript('');
      setSourceMarkdown(input.markdown);
      setAdapted(input.rewriteForNarration);
      setChunks([]);
      setErrorMessage(null);
      setStatus('starting');

      const token = await currentIdToken();
      if (!token) {
        setStatus('error');
        setErrorMessage(SIGN_IN_REQUIRED);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const activePlayer = ensurePlayer();

      let response: Response;
      try {
        response = await fetch('/api/narrations', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
        });
      } catch {
        if (!controller.signal.aborted) {
          setStatus('error');
          setErrorMessage(GENERIC_FAILURE);
        }
        return;
      }

      if (!response.ok || !response.body) {
        setStatus('error');
        setErrorMessage(await readMessage(response, GENERIC_FAILURE));
        return;
      }

      setStatus('streaming');

      const handleEvent = (event: StreamEvent) => {
        switch (event.type) {
          case 'meta':
            setId(event.id);
            setTitle(event.title);
            setVoice(event.voice);
            break;
          case 'transcript':
            setTranscript(event.transcript);
            break;
          case 'audio':
            activePlayer.append(decodeBase64Pcm(event.pcm));
            break;
          case 'chunk': {
            const landed = event.chunk;
            startNonUrgent(() => {
              setChunks((previous) => [...previous, landed]);
            });
            break;
          }
          case 'done':
            setId(event.id);
            setStatus('ready');
            break;
          case 'error':
            setStatus('error');
            setErrorMessage(event.message);
            break;
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const consumeLines = (flush: boolean) => {
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            try {
              handleEvent(JSON.parse(line) as StreamEvent);
            } catch {
              // Ignore incomplete frame
            }
          }
          newline = buffer.indexOf('\n');
        }
        if (flush && buffer.trim().length > 0) {
          try {
            handleEvent(JSON.parse(buffer.trim()) as StreamEvent);
          } catch {
            // Ignore incomplete frame
          }
          buffer = '';
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consumeLines(false);
        }
        buffer += decoder.decode();
        consumeLines(true);
      } catch {
        if (!controller.signal.aborted) {
          setStatus('error');
          setErrorMessage(GENERIC_FAILURE);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [ensurePlayer, resetPlayer, startNonUrgent],
  );

  const idRef = useRef<string | null>(null);
  const statusRef = useRef<NarrationStreamState['status']>('idle');
  idRef.current = id;
  statusRef.current = status;

  const loadExisting = useCallback<NarrationStreamState['loadExisting']>(
    async (narrationId, options) => {
      // If this narration is already loaded and ready in the player, reuse it directly
      // from memory instead of tearing down and re-downloading from Storage.
      if (
        idRef.current === narrationId &&
        statusRef.current === 'ready' &&
        playerRef.current !== null &&
        playerRef.current.durationMs > 0
      ) {
        if (options?.autoPlay) {
          void playerRef.current.play();
        }
        return;
      }

      abortRef.current?.abort();
      abortRef.current = null;
      resetPlayer();

      const session = ++loadSessionRef.current;

      setId(narrationId);
      setTitle('');
      setVoice(null);
      setTranscript('');
      setSourceMarkdown(null);
      setAdapted(false);
      setChunks([]);
      setErrorMessage(null);
      setStatus('loading');

      const mediaStore = getMediaStore();
      const offlineTrack = await mediaStore.getTrack(narrationId);
      if (session !== loadSessionRef.current) return;

      if (offlineTrack) {
        if (offlineTrack.timings.title) {
          setTitle((current) => (current.trim().length > 0 ? current : offlineTrack.timings.title));
        }
        if (offlineTrack.timings.transcript) setTranscript(offlineTrack.timings.transcript);
        setChunks([...offlineTrack.timings.chunks].sort((a, b) => a.index - b.index));

        const objectUrl = URL.createObjectURL(offlineTrack.audioBlob);
        const activePlayer = ensurePlayer();
        try {
          await activePlayer.loadWavUrl(objectUrl, { final: true });
        } finally {
          URL.revokeObjectURL(objectUrl);
        }

        if (options?.autoPlay) {
          void activePlayer.play();
        }
        setStatus('ready');
        return;
      }

      const token = await currentIdToken();
      if (session !== loadSessionRef.current) return;
      if (!token) {
        setStatus('error');
        setErrorMessage(SIGN_IN_REQUIRED);
        return;
      }

      const headers = { Authorization: `Bearer ${token}` };
      let lastDurationMs = -1;
      let autoPlayed = false;
      let loadChain = Promise.resolve();

      const pullCheckpoint = async (isFinal: boolean): Promise<boolean> => {
        if (session !== loadSessionRef.current) return false;
        try {
          const [audioResponse, timingsResponse] = await Promise.all([
            fetch(`/api/narrations/${narrationId}/audio?raw=1`, { headers }),
            fetch(`/api/narrations/${narrationId}/timings?raw=1`, { headers }),
          ]);

          if (session !== loadSessionRef.current) return false;

          if (!audioResponse.ok || !timingsResponse.ok) {
            if (isFinal) {
              const failing = audioResponse.ok ? timingsResponse : audioResponse;
              setStatus('error');
              setErrorMessage(await readMessage(failing, LOAD_FAILURE));
            }
            return false;
          }

          const [audioBlob, timingsFile] = await Promise.all([
            audioResponse.blob(),
            timingsResponse.json() as Promise<NarrationTimingsFile>,
          ]);

          if (session !== loadSessionRef.current) return false;

          if (timingsFile.title) {
            setTitle((current) => (current.trim().length > 0 ? current : timingsFile.title));
          }
          if (timingsFile.transcript) setTranscript(timingsFile.transcript);
          setChunks([...timingsFile.chunks].sort((a, b) => a.index - b.index));

          const objectUrl = URL.createObjectURL(audioBlob);
          const activePlayer = ensurePlayer();
          try {
            await activePlayer.loadWavUrl(objectUrl, { final: isFinal });
          } finally {
            URL.revokeObjectURL(objectUrl);
          }

          if (isFinal) {
            void mediaStore.saveTrack(narrationId, audioBlob, timingsFile).catch(() => {});
          }

          if (options?.autoPlay && !autoPlayed) {
            autoPlayed = true;
            void activePlayer.play();
          }
          return true;
        } catch {
          if (session !== loadSessionRef.current) return false;
          if (isFinal) {
            setStatus('error');
            setErrorMessage(LOAD_FAILURE);
          }
          return false;
        }
      };

      const stopDocWatch = () => {
        docUnsubRef.current?.();
        docUnsubRef.current = null;
      };

      stopDocWatch();
      if (session !== loadSessionRef.current) return;

      docUnsubRef.current = watchNarration(narrationId, (narration) => {
        if (session !== loadSessionRef.current) {
          stopDocWatch();
          return;
        }

        if (!narration) {
          setStatus('error');
          setErrorMessage(LOAD_FAILURE);
          stopDocWatch();
          return;
        }

        if (narration.title) setTitle(narration.title);
        if (narration.voice) setVoice(narration.voice);
        if (narration.transcript) setTranscript(narration.transcript);
        if (narration.sourceMarkdown !== undefined) setSourceMarkdown(narration.sourceMarkdown);
        if (narration.adapted !== undefined) setAdapted(narration.adapted);

        if (narration.status === 'error') {
          setStatus('error');
          setErrorMessage(narration.errorMessage ?? LOAD_FAILURE);
          stopDocWatch();
          return;
        }

        const isStaleStreaming =
          narration.status === 'streaming' &&
          narration.durationMs > 0 &&
          Date.now() - narration.updatedAt > 15_000;

        if (narration.status === 'streaming' && !isStaleStreaming) {
          setStatus('streaming');
          if (narration.durationMs > 0 && narration.durationMs !== lastDurationMs) {
            lastDurationMs = narration.durationMs;
            loadChain = loadChain.then(() => pullCheckpoint(false)).then(() => undefined);
          }
          return;
        }

        if (narration.status === 'ready' || isStaleStreaming) {
          stopDocWatch();
          loadChain = loadChain
            .then(() => pullCheckpoint(true))
            .then((ok) => {
              if (ok && session === loadSessionRef.current) setStatus('ready');
            });
        }
      });
    },
    [ensurePlayer, resetPlayer],
  );

  const cancel = useCallback(() => {
    loadSessionRef.current++;
    docUnsubRef.current?.();
    docUnsubRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    playerRef.current?.pause();
    setStatus((previous) => (previous === 'starting' || previous === 'streaming' ? 'idle' : previous));
  }, []);

  const words = useMemo(() => chunks.flatMap((chunk) => chunk.words), [chunks]);
  const activeWord = findActiveWord(words, transport.positionMs);

  return {
    id,
    title,
    setTitle,
    voice,
    transcript,
    chunks,
    status,
    errorMessage,
    player,
    positionMs: transport.positionMs,
    durationMs: transport.durationMs,
    playing: transport.playing,
    activeWord,
    sourceMarkdown,
    adapted,
    start,
    loadExisting,
    cancel,
  };
}
