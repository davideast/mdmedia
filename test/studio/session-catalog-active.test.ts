import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { isSessionActive, SessionCatalogService } from '../../src/studio/session-catalog.js';

describe('SessionCatalogService - Active Session Detection & Sorting', () => {
  let tempDir: string;
  let brainDir: string;
  let libraryDir: string;
  let library: AudioLibrary;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `mdmedia_test_active_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    brainDir = path.join(tempDir, 'brain');
    libraryDir = path.join(tempDir, 'library');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    library = new AudioLibrary(libraryDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects active sessions based on recent mtime and uncompleted step status', () => {
    const activeDir = path.join(brainDir, 'active-session-01', '.system_generated/logs');
    fs.mkdirSync(activeDir, { recursive: true });
    const activeFile = path.join(activeDir, 'transcript.jsonl');

    // Last step is RUNNING or in-flight tool call
    fs.writeFileSync(
      activeFile,
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Do something' }) + '\n' +
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'run_command' }],
        content: 'Running build...',
      }),
      'utf8'
    );

    const now = Date.now();
    expect(isSessionActive(activeFile, now - 5000, now)).toBe(true);

    // Old session (> 90s) is not active even if last step was RUNNING
    expect(isSessionActive(activeFile, now - 120_000, now)).toBe(false);
  });

  it('detects completed/idle sessions when last step is DONE with zero tool_calls', () => {
    const idleDir = path.join(brainDir, 'idle-session-02', '.system_generated/logs');
    fs.mkdirSync(idleDir, { recursive: true });
    const idleFile = path.join(idleDir, 'transcript.jsonl');

    fs.writeFileSync(
      idleFile,
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Do something' }) + '\n' +
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [],
        content: '# Finished Task\n\nAll operations completed cleanly.',
      }),
      'utf8'
    );

    const now = Date.now();
    expect(isSessionActive(idleFile, now - 5000, now)).toBe(false);
  });

  it('lists sessions with ACTIVE sessions sorted to the top, followed by idle sessions', () => {
    const s1 = 'session-active-1';
    const s2 = 'session-idle-old';
    const s3 = 'session-active-2';
    const s4 = 'session-idle-new';

    const now = Date.now();
    const createSession = (id: string, mtimeOffsetMs: number, lastStepRunning: boolean, title: string) => {
      const dir = path.join(brainDir, id, '.system_generated/logs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: title }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: lastStepRunning ? 'RUNNING' : 'DONE',
          tool_calls: lastStepRunning ? [{ name: 'run' }] : [],
          content: `# ${title}\n\nHere is the substantive output for testing.`,
        }),
      ];
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      const targetMtime = new Date(now - mtimeOffsetMs);
      fs.utimesSync(file, targetMtime, targetMtime);
    };

    createSession(s1, 10_000, true, 'Active Task 1'); // Active, modified 10s ago
    createSession(s2, 500_000, false, 'Old Idle Task'); // Idle, modified 500s ago
    createSession(s3, 5_000, true, 'Active Task 2'); // Active, modified 5s ago (newest active)
    createSession(s4, 20_000, false, 'New Idle Task'); // Idle, modified 20s ago

    const service = new SessionCatalogService({ brainDir, library });
    const sessions = service.listSessions();

    expect(sessions.length).toBe(4);
    // Active sessions must come first
    expect(sessions[0].id).toBe(s3);
    expect(sessions[0].isActive).toBe(true);

    expect(sessions[1].id).toBe(s1);
    expect(sessions[1].isActive).toBe(true);

    // Idle sessions follow below, sorted newest first
    expect(sessions[2].id).toBe(s4);
    expect(sessions[2].isActive).toBe(false);

    expect(sessions[3].id).toBe(s2);
    expect(sessions[3].isActive).toBe(false);
  });
});
