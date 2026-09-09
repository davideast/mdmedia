import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { PlaybackEngine } from '../../src/audio/player/playback-engine.js';
import { StudioStore } from '../../src/studio/studio-store.js';
import type { ITTSProvider } from '../../src/tts/tts-provider.interface.js';

describe('StudioStore Session & Turn Integration (R2)', () => {
  let tempDir: string;
  let brainDir: string;
  let libraryDir: string;
  let library: AudioLibrary;
  let player: PlaybackEngine;

  const mockTtsProvider: ITTSProvider = {
    async *streamAudio() {
      yield new Uint8Array(2400);
      yield new Uint8Array(2400);
    },
  };

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `mdmedia_test_studio_sessions_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    brainDir = path.join(tempDir, 'brain');
    libraryDir = path.join(tempDir, 'audio_library');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });

    library = new AudioLibrary(libraryDir);
    player = new PlaybackEngine();
  });

  afterEach(() => {
    player.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function setupSessionTranscript(convId: string) {
    const convLogsDir = path.join(brainDir, convId, '.system_generated/logs');
    fs.mkdirSync(convLogsDir, { recursive: true });

    const steps = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-08T12:00:00Z',
        content: '# First Turn\n\nThis turn has cached audio.',
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-08T12:05:00Z',
        content: '# Second Turn\n\nThis turn is ungenerated.',
      },
    ];

    fs.writeFileSync(
      path.join(convLogsDir, 'transcript.jsonl'),
      steps.map((s) => JSON.stringify(s)).join('\n'),
      'utf8'
    );
  }

  it('initializes turns from SessionCatalogService and supports selectTurn for cached and ungenerated turns', async () => {
    const convId = 'b1111111-2222-3333-4444-555555555555';
    setupSessionTranscript(convId);

    const savedTrack = await library.saveTrack({
      sessionId: convId,
      stepIndex: 1,
      markdown: '# First Turn\n\nThis turn has cached audio.',
      audioBuffer: new Uint8Array(9600),
      voice: 'Puck',
    });

    const store = new StudioStore({
      library,
      player,
      brainDir,
      ttsProvider: mockTtsProvider,
      enableLiveAudio: false,
    });

    const state = store.getState();
    expect(state.turns).toHaveLength(2);
    expect(state.viewMode).toBe('markdown');
    expect(state.audioOnlyFilter).toBe(false);

    const ungenTurn = state.turns.find((t) => t.stepIndex === 2)!;
    const cachedTurn = state.turns.find((t) => t.stepIndex === 1)!;
    expect(ungenTurn.status).toBe('ungenerated');
    expect(cachedTurn.status).toBe('cached');

    await store.selectTurn(cachedTurn.id);
    expect(store.getState().selectedTurn?.id).toBe(cachedTurn.id);
    expect(store.getState().selectedTrack?.id).toBe(savedTrack.id);

    await store.selectTurn(ungenTurn.id);
    expect(store.getState().selectedTurn?.id).toBe(ungenTurn.id);
    expect(store.getState().selectedTrack).toBeNull();
  });

  it('activateTurn plays cached WAV when turn is cached', async () => {
    const convId = 'c1111111-2222-3333-4444-555555555555';
    setupSessionTranscript(convId);

    const savedTrack = await library.saveTrack({
      sessionId: convId,
      stepIndex: 1,
      markdown: '# First Turn\n\nThis turn has cached audio.',
      audioBuffer: new Uint8Array(9600),
      voice: 'Puck',
    });

    const store = new StudioStore({
      library,
      player,
      brainDir,
      ttsProvider: mockTtsProvider,
      enableLiveAudio: false,
    });

    const cachedTurn = store.getState().turns.find((t) => t.stepIndex === 1)!;
    await store.activateTurn(cachedTurn.id);

    expect(store.getState().selectedTurn?.id).toBe(cachedTurn.id);
    expect(store.getState().selectedTrack?.id).toBe(savedTrack.id);
    expect(player.currentTrack?.id).toBe(savedTrack.id);
  });

  it('activateTurn synthesizes live audio via handleLiveTurn when turn is ungenerated', async () => {
    const convId = 'd1111111-2222-3333-4444-555555555555';
    setupSessionTranscript(convId);

    const store = new StudioStore({
      library,
      player,
      brainDir,
      ttsProvider: mockTtsProvider,
      enableLiveAudio: false,
    });

    const ungenTurn = store.getState().turns.find((t) => t.stepIndex === 2)!;
    expect(ungenTurn.status).toBe('ungenerated');

    let observedSynthesizing = false;
    store.subscribe((s) => {
      const target = s.turns.find((t) => t.id === ungenTurn.id);
      if (target?.status === 'synthesizing') {
        observedSynthesizing = true;
      }
    });

    await store.activateTurn(ungenTurn.id);

    expect(observedSynthesizing).toBe(true);
    const updatedTurn = store.getState().turns.find((t) => t.id === ungenTurn.id)!;
    expect(updatedTurn.status).toBe('cached');
    expect(updatedTurn.track).toBeDefined();
    expect(store.getState().selectedTurn?.id).toBe(ungenTurn.id);
    expect(store.getState().selectedTrack?.id).toBe(updatedTurn.track?.id);
  });

  it('toggleAudioOnlyFilter and toggleViewMode update store state and turn list', async () => {
    const convId = 'e1111111-2222-3333-4444-555555555555';
    setupSessionTranscript(convId);

    await library.saveTrack({
      sessionId: convId,
      stepIndex: 1,
      markdown: '# First Turn\n\nThis turn has cached audio.',
      audioBuffer: new Uint8Array(9600),
      voice: 'Puck',
    });

    const store = new StudioStore({
      library,
      player,
      brainDir,
      ttsProvider: mockTtsProvider,
      enableLiveAudio: false,
    });

    expect(store.getState().turns).toHaveLength(2);
    expect(store.getState().audioOnlyFilter).toBe(false);

    store.toggleAudioOnlyFilter();
    expect(store.getState().audioOnlyFilter).toBe(true);
    expect(store.getState().turns).toHaveLength(1);
    expect(store.getState().turns[0].status).toBe('cached');

    store.toggleAudioOnlyFilter();
    expect(store.getState().audioOnlyFilter).toBe(false);
    expect(store.getState().turns).toHaveLength(2);

    expect(store.getState().viewMode).toBe('markdown');
    store.toggleViewMode();
    expect(store.getState().viewMode).toBe('script');
    store.toggleViewMode();
    expect(store.getState().viewMode).toBe('markdown');
  });

  it('activateTurn invokes narrationAdapter when configured on StudioStore', async () => {
    const convId = 'f1111111-2222-3333-4444-555555555555';
    setupSessionTranscript(convId);

    let adapterCalled = false;
    const mockAdapter = {
      async adaptForNarration(markdown: string) {
        adapterCalled = true;
        return `# Adapted Narration\n\nThis is the narration-adapted version of ${markdown.slice(0, 15)}.`;
      },
    };

    const store = new StudioStore({
      library,
      player,
      brainDir,
      ttsProvider: mockTtsProvider,
      narrationAdapter: mockAdapter,
      enableLiveAudio: false,
    });

    const ungenTurn = store.getState().turns.find((t) => t.stepIndex === 2)!;
    await store.activateTurn(ungenTurn.id);

    expect(adapterCalled).toBe(true);
    const updatedTurn = store.getState().turns.find((t) => t.id === ungenTurn.id)!;
    expect(updatedTurn.status).toBe('cached');
    expect(updatedTurn.track?.transcript).toContain('This is the narration-adapted version');
  });
});
