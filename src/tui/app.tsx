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
      setFocusedPane((prev) => (prev === 'library' ? 'transcript' : 'library'));
      return;
    }

    if (key.name === 'space' || key.sequence === ' ') {
      actions.togglePause();
      return;
    }

    if (key.name === 'left') {
      actions.scrub(-5000);
      return;
    }

    if (key.name === 'right') {
      actions.scrub(5000);
      return;
    }

    if (key.name === 'h' || key.sequence === 'h' || key.sequence === 'H') {
      actions.scrub(-30000);
      return;
    }

    if (key.name === 'l' || key.sequence === 'l' || key.sequence === 'L') {
      actions.scrub(30000);
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
      if (key.name === 'up' || key.name === 'k' || key.sequence === 'k') {
        setTranscriptScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.name === 'down' || key.name === 'j' || key.sequence === 'j') {
        setTranscriptScrollOffset((prev) => prev + 1);
        return;
      }
      if (key.name === 'pageup' || key.sequence === 'u') {
        setTranscriptScrollOffset((prev) => Math.max(0, prev - 5));
        return;
      }
      if (key.name === 'pagedown' || key.sequence === 'd') {
        setTranscriptScrollOffset((prev) => prev + 5);
        return;
      }
    }

    if (key.name === 'up' || key.name === 'k' || key.sequence === 'k') {
      if (state.turns.length > 0) {
        const currentIdx = state.turns.findIndex((t) => t.id === state.selectedTurn?.id);
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
        if (state.turns[prevIdx]) {
          actions.selectTurn(state.turns[prevIdx].id);
          setTranscriptScrollOffset(0);
        }
      } else {
        const currentIdx = state.tracks.findIndex((t) => t.id === state.selectedTrack?.id);
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
        if (state.tracks[prevIdx]) {
          actions.selectTrack(state.tracks[prevIdx].id);
          setTranscriptScrollOffset(0);
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
        }
      } else {
        const currentIdx = state.tracks.findIndex((t) => t.id === state.selectedTrack?.id);
        const nextIdx =
          currentIdx >= 0 && currentIdx < state.tracks.length - 1
            ? currentIdx + 1
            : state.tracks.length - 1;
        if (state.tracks[nextIdx]) {
          actions.selectTrack(state.tracks[nextIdx].id);
          setTranscriptScrollOffset(0);
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
        trackCount={state.turns.length || state.tracks.length}
        copyNotification={copyToast}
      />
      <box flexDirection="row" flexGrow={1} width="100%">
        <LibraryPane
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
          track={state.selectedTrack}
          turn={state.selectedTurn}
          viewMode={state.viewMode}
          positionMs={state.playback.positionMs}
          activeChunkIndex={state.playback.activeChunkIndex}
          liveStreaming={state.live.isStreaming}
          currentLiveChunkText={state.live.currentChunkText}
          focused={focusedPane === 'transcript'}
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
