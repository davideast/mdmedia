import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { isSessionActive, SessionCatalogService } from '../../src/studio/session-catalog.js';

describe('SessionCatalogService - Active Jetski CLI Session Detection & Sorting', () => {
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

  it('detects active sessions based on open Jetski CLI session presence', () => {
    const activeId = 'active-cli-session-01';
    const idleId = 'idle-closed-session-02';
    const activeSet = new Set([activeId]);

    expect(isSessionActive(activeId, activeSet)).toBe(true);
    expect(isSessionActive(idleId, activeSet)).toBe(false);
  });

  it('lists conversations with active Jetski CLI sessions pinned to top, followed by inactive sessions', () => {
    const s1 = 'session-active-1';
    const s2 = 'session-idle-old';
    const s3 = 'session-active-2';
    const s4 = 'session-idle-new';

    const now = Date.now();
    const createSession = (id: string, mtimeOffsetMs: number, title: string) => {
      const dir = path.join(brainDir, id, '.system_generated/logs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: title }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: `# ${title}\n\nHere is the substantive output for testing.`,
        }),
      ];
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      const targetMtime = new Date(now - mtimeOffsetMs);
      fs.utimesSync(file, targetMtime, targetMtime);
    };

    createSession(s1, 10_000, 'Active CLI Session 1');
    createSession(s2, 500_000, 'Old Inactive Task');
    createSession(s3, 5_000, 'Active CLI Session 2');
    createSession(s4, 20_000, 'New Inactive Task');

    // s1 and s3 are open Jetski CLI sessions
    const activeSessionIds = new Set([s1, s3]);
    const service = new SessionCatalogService({ brainDir, library, activeSessionIds });
    const sessions = service.listSessions();

    expect(sessions.length).toBe(4);
    // Active CLI sessions must come first
    expect(sessions[0].id).toBe(s3);
    expect(sessions[0].isActive).toBe(true);

    expect(sessions[1].id).toBe(s1);
    expect(sessions[1].isActive).toBe(true);

    // Inactive sessions follow below, sorted newest first
    expect(sessions[2].id).toBe(s4);
    expect(sessions[2].isActive).toBe(false);

    expect(sessions[3].id).toBe(s2);
    expect(sessions[3].isActive).toBe(false);
  });
});
