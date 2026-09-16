import { useState } from 'react';
import { useKeyboard, createRoot } from '@opentui/react';
import { createCliRenderer } from '@opentui/core';
import { StudioStore } from '../studio/studio-store.js';
import { AntigravityWatcher, getGeminiApiKey } from '../studio/antigravity-watcher.js';
import { GoogleGenAI } from '@google/genai';
import { GeminiTTSProvider } from '../tts/gemini-tts-provider.js';
import { useStudioStore } from './hooks/use-studio-store.js';
import { HeaderBar } from './components/header-bar.js';
import { LibraryPane } from './components/library-pane.js';
import { TranscriptPane } from './components/transcript-pane.js';
import { TransportDeck } from './components/transport-deck.js';
import { copyToSystemClipboard } from '../studio/clipboard.js';

export interface StudioAppProps {
  store: StudioStore;
  onExit: () => void;
}

export function StudioApp({ store, onExit }: StudioAppProps) {
  const { state, actions } = useStudioStore(store);
  const [focusedPane, setFocusedPane] = useState<'library' | 'transcript'>('library');
  const [filterActive, setFilterActive] = useState(false);
  const [filterBuffer, setFilterBuffer] = useState('');
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [selectedTranscriptIndex, setSelectedTranscriptIndex] = useState(0);
  const [copyToast, setCopyToast] = useState<string | null>(null);

  useKeyboard((key) => {
    if ((key.ctrl && key.name === 'c') || (!filterActive && key.name === 'q')) {
      onExit();
      return;
    }

    if (key.name === 'y' || key.sequence === 'y' || (key.meta && key.name === 'c')) {
      const textToCopy =
        state.selectedTurn?.markdown ?? state.selectedTrack?.transcript ?? '';
      if (textToCopy) {
        copyToSystemClipboard(textToCopy).then((ok) => {
          if (ok) {
            setCopyToast('Copied transcript to clipboard');
            setTimeout(() => setCopyToast(null), 2500);
          }
        });
      }
      return;
    }

    if (filterActive) {
      if (key.name === 'escape' || key.name === 'return') {
        setFilterActive(false);
        return;
      }
      if (key.name === 'backspace') {
        const next = filterBuffer.slice(0, -1);
        setFilterBuffer(next);
        actions.setFilter(next);
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        const next = filterBuffer + key.sequence;
        setFilterBuffer(next);
        actions.setFilter(next);
        return;
      }
      return;
    }

    // Normal navigation mode
    if (key.sequence === '/') {
      setFilterActive(true);
      return;
    }

    if (key.name === 'tab') {
      setFocusedPane((prev) => {
        const next = prev === 'library' ? 'transcript' : 'library';
        if (next === 'transcript') {
          setSelectedTranscriptIndex(
            state.playback.activeChunkIndex >= 0 ? state.playback.activeChunkIndex : 0
          );
        }
        return next;
      });
      return;
    }

    if (key.name === 'space' || key.sequence === ' ') {
      actions.togglePause();
      return;
    }

    if (key.sequence === '[' || key.name === '[') {
      actions.scrub(-10000);
      return;
    }

    if (key.sequence === ']' || key.name === ']') {
      actions.scrub(10000);
      return;
    }

    if (key.sequence === '>' || key.sequence === '.') {
      actions.setRate(Math.min(2.5, state.playback.rate + 0.25));
      return;
    }

    if (key.sequence === '<' || key.sequence === ',') {
      actions.setRate(Math.max(0.5, state.playback.rate - 0.25));
      return;
    }

    if (key.sequence === 'f' || key.name === 'f') {
      actions.toggleAudioOnlyFilter();
      return;
    }

    if (key.sequence === 'v' || key.name === 'v') {
      actions.toggleViewMode();
      return;
    }

    if (focusedPane === 'transcript') {
      if (
        key.name === 'escape' ||
        key.name === 'left' ||
        key.name === 'h' ||
        key.sequence === 'h'
      ) {
        setFocusedPane('library');
        return;
      }

      if (key.name === 'up' || key.name === 'k' || key.sequence === 'k') {
        setSelectedTranscriptIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.name === 'down' || key.name === 'j' || key.sequence === 'j') {
        setSelectedTranscriptIndex((prev) => prev + 1);
        return;
      }
      if (key.name === 'pageup' || key.sequence === 'u') {
        setSelectedTranscriptIndex((prev) => Math.max(0, prev - 6));
        return;
      }
      if (key.name === 'pagedown' || key.sequence === 'd') {
        setSelectedTranscriptIndex((prev) => prev + 6);
        return;
      }
      if (key.sequence === 'g' || key.name === 'home') {
        setSelectedTranscriptIndex(0);
        return;
      }
      if (key.sequence === 'G' || key.name === 'end') {
        setSelectedTranscriptIndex(999999);
        return;
      }
      if (key.name === 'return') {
        const currentChunkTimings =
          state.selectedTrack?.chunkTimings && state.selectedTrack.chunkTimings.length > 0
            ? state.selectedTrack.chunkTimings
            : state.selectedTurn?.track?.chunkTimings ?? [];
        if (currentChunkTimings.length > 0) {
          const clampedIdx = Math.max(
            0,
            Math.min(currentChunkTimings.length - 1, selectedTranscriptIndex)
          );
          const targetChunk = currentChunkTimings[clampedIdx];
          if (targetChunk) {
            actions.seek(targetChunk.startMs);
            if (state.playback.status !== 'playing') {
              actions.play();
            }
          }
        } else if (state.selectedTurn) {
          actions.activateTurn(state.selectedTurn.id);
        }
        return;
      }
    }

    // Focused on Library Pane
    if (state.navDepth === 'sessions') {
      if (key.name === 'up' || key.name === 'k' || key.sequence === 'k') {
        if (state.sessions.length > 0) {
          const currentIdx = state.sessions.findIndex((s) => s.id === state.selectedSession?.id);
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
          if (state.sessions[prevIdx]) {
            actions.selectSession(state.sessions[prevIdx].id);
          }
        }
        return;
      }

      if (key.name === 'down' || key.name === 'j' || key.sequence === 'j') {
        if (state.sessions.length > 0) {
          const currentIdx = state.sessions.findIndex((s) => s.id === state.selectedSession?.id);
          const nextIdx =
            currentIdx >= 0 && currentIdx < state.sessions.length - 1
              ? currentIdx + 1
              : state.sessions.length - 1;
          if (state.sessions[nextIdx]) {
            actions.selectSession(state.sessions[nextIdx].id);
          }
        }
        return;
      }

      if (
        key.name === 'return' ||
        key.name === 'right' ||
        key.name === 'l' ||
        key.sequence === 'l'
      ) {
        actions.drillIntoSession();
        setTranscriptScrollOffset(0);
        setSelectedTranscriptIndex(0);
        return;
      }
    }

    if (state.navDepth === 'turns') {
      if (
        key.name === 'escape' ||
        key.name === 'backspace' ||
        key.name === 'left' ||
        key.name === 'h' ||
        key.sequence === 'h'
      ) {
        actions.zoomOutToSessions();
        return;
      }

      if (
        key.name === 'right' ||
        key.name === 'l' ||
        key.sequence === 'l'
      ) {
        setFocusedPane('transcript');
        setSelectedTranscriptIndex(
          state.playback.activeChunkIndex >= 0 ? state.playback.activeChunkIndex : 0
        );
        return;
      }

      if (key.name === 'up' || key.name === 'k' || key.sequence === 'k') {
        if (state.turns.length > 0) {
          const currentIdx = state.turns.findIndex((t) => t.id === state.selectedTurn?.id);
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
          if (state.turns[prevIdx]) {
            actions.selectTurn(state.turns[prevIdx].id);
            setTranscriptScrollOffset(0);
            setSelectedTranscriptIndex(0);
          }
        }
        return;
      }

      if (key.name === 'down' || key.name === 'j' || key.sequence === 'j') {
        if (state.turns.length > 0) {
          const currentIdx = state.turns.findIndex((t) => t.id === state.selectedTurn?.id);
          const nextIdx =
            currentIdx >= 0 && currentIdx < state.turns.length - 1
              ? currentIdx + 1
              : state.turns.length - 1;
          if (state.turns[nextIdx]) {
            actions.selectTurn(state.turns[nextIdx].id);
            setTranscriptScrollOffset(0);
            setSelectedTranscriptIndex(0);
          }
        }
        return;
      }

      if (key.name === 'return') {
        if (state.selectedTurn) {
          actions.activateTurn(state.selectedTurn.id);
        } else if (state.selectedTrack) {
          actions.play(state.selectedTrack.id);
        }
        return;
      }
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#0f172a"
    >
      <HeaderBar
        live={state.live}
        playback={state.playback}
        trackCount={state.navDepth === 'sessions' ? state.sessions.length : state.turns.length}
        copyNotification={copyToast}
      />
      <box flexDirection="row" flexGrow={1} width="100%">
        <LibraryPane
          navDepth={state.navDepth}
          sessions={state.sessions}
          selectedSession={state.selectedSession}
          tracks={state.tracks}
          selectedTrack={state.selectedTrack}
          turns={state.turns}
          selectedTurn={state.selectedTurn}
          audioOnlyFilter={state.audioOnlyFilter}
          playingTrackId={
            state.playback.status === 'playing' ? state.selectedTrack?.id ?? null : null
          }
          filterQuery={filterBuffer}
          focused={focusedPane === 'library'}
          filterActive={filterActive}
        />
        <TranscriptPane
          navDepth={state.navDepth}
          selectedSession={state.selectedSession}
          track={state.selectedTrack}
          turn={state.selectedTurn}
          viewMode={state.viewMode}
          positionMs={state.playback.positionMs}
          activeChunkIndex={state.playback.activeChunkIndex}
          liveStreaming={state.live.isStreaming}
          currentLiveChunkText={state.live.currentChunkText}
          focused={focusedPane === 'transcript'}
          selectedIndex={selectedTranscriptIndex}
          scrollOffset={transcriptScrollOffset}
        />
      </box>
      <TransportDeck
        playback={state.playback}
        track={state.selectedTrack}
        live={state.live}
      />
    </box>
  );
}

export async function startStudioTui(store?: StudioStore): Promise<void> {
  let activeStore = store;
  if (!activeStore) {
    let provider: GeminiTTSProvider | undefined;
    const apiKey = getGeminiApiKey();
    if (apiKey) {
      const client = new GoogleGenAI({ apiKey });
      provider = new GeminiTTSProvider(client);
    }
    activeStore = new StudioStore({
      ttsProvider: provider,
      enableLiveAudio: true,
    });
  }

  const watcher = new AntigravityWatcher(activeStore);
  watcher.start();

  const renderer = await createCliRenderer({ useMouse: false });

  function cleanup() {
    try {
      activeStore?.abortLiveTurn();
      activeStore?.getPlayer().stop();
      watcher.stop();
      process.stdout.write('\x1b[?25h'); // Ensure cursor is always restored
      renderer.destroy();
    } catch {}
  }

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });

  const root = createRoot(renderer);
  root.render(
    <StudioApp
      store={activeStore}
      onExit={() => {
        cleanup();
        process.exit(0);
      }}
    />
  );
}
