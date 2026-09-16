import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { PlaybackEngine } from '../../src/audio/player/playback-engine.js';
import { StudioStore } from '../../src/studio/studio-store.js';

describe('StudioStore - Two-Level Navigation & Hierarchy', () => {
  let tempDir: string;
  let brainDir: string;
  let libraryDir: string;
  let library: AudioLibrary;
  let player: PlaybackEngine;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `mdmedia_test_store_hierarchy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    brainDir = path.join(tempDir, 'brain');
    libraryDir = path.join(tempDir, 'library');
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

  function createSession(convId: string, title: string, turns: { step: number; title: string; content: string }[]) {
    const convDir = path.join(brainDir, convId, '.system_generated/logs');
    fs.mkdirSync(convDir, { recursive: true });
    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: title }),
      ...turns.map((t) =>
        JSON.stringify({
          step_index: t.step,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: `# ${t.title}\n\n${t.content}`,
        })
      ),
    ];
    fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), lines.join('\n'), 'utf8');
  }

  it('initializes with navDepth="sessions", lists sessions, and supports drillIntoSession and zoomOutToSessions', () => {
    const s1 = 'session-1111-1111';
    const s2 = 'session-2222-2222';

    createSession(s1, 'Alpha Conversation', [
      { step: 1, title: 'Alpha Turn 1', content: 'Substantive content for alpha turn 1.' },
    ]);
    createSession(s2, 'Beta Conversation', [
      { step: 1, title: 'Beta Turn 1', content: 'Substantive content for beta turn 1.' },
      { step: 2, title: 'Beta Turn 2', content: 'Substantive content for beta turn 2.' },
    ]);

    const store = new StudioStore({
      library,
      player,
      brainDir,
      enableLiveAudio: false,
    });

    const state = store.getState();
    expect(state.navDepth).toBe('sessions');
    expect(state.sessions.length).toBe(2);

    // Drill into s2
    store.drillIntoSession(s2);
    const drilledState = store.getState();
    expect(drilledState.navDepth).toBe('turns');
    expect(drilledState.selectedSession?.id).toBe(s2);
    expect(drilledState.turns.length).toBe(2);
    expect(drilledState.selectedTurn?.title).toBe('Beta Turn 2'); // Newest first

    // Zoom back out to sessions
    store.zoomOutToSessions();
    const zoomedState = store.getState();
    expect(zoomedState.navDepth).toBe('sessions');
    expect(zoomedState.selectedSession?.id).toBe(s2);
  });
});
