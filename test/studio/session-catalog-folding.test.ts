import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import {
  isSubstantiveResponse,
  SessionCatalogService,
} from '../../src/studio/session-catalog.js';

describe('SessionCatalogService - AST Substantive Detection & Folding', () => {
  let tempDir: string;
  let brainDir: string;
  let libraryDir: string;
  let library: AudioLibrary;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `mdmedia_test_folding_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
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

  it('classifies responses as substantive using word count and AST structural tokens without regex', () => {
    // 1. Tool dispatch with short text -> not substantive (intermediate ping)
    expect(isSubstantiveResponse("I'll run the test command now.", true)).toBe(false);

    // 2. Short response with no structure -> not substantive
    expect(isSubstantiveResponse("Done. I will check the file next.", false)).toBe(false);

    // 3. Response with Markdown heading -> substantive
    expect(isSubstantiveResponse("# Test Results\n\nAll tests passed cleanly.", false)).toBe(true);

    // 4. Response with Markdown list -> substantive
    expect(isSubstantiveResponse("Here is the plan:\n- Step 1: Run build\n- Step 2: Test", false)).toBe(true);

    // 5. Response with Markdown table -> substantive
    expect(isSubstantiveResponse("| Col 1 | Col 2 |\n|---|---|\n| A | B |", false)).toBe(true);

    // 6. Long plain text without structure (>= 30 words) -> substantive
    const longText =
      'We have completely redesigned the terminal user interface dashboard to provide two distinct hierarchical levels: a high-level session browser with active session indicators, and a detailed turn view where intermediate tool execution pings are cleanly aggregated into the parent response.';
    expect(isSubstantiveResponse(longText, false)).toBe(true);
  });

  it('folds intermediate tool pings into the subsequent substantive turn', () => {
    const convId = 'session-folding-test';
    const convLogsDir = path.join(brainDir, convId, '.system_generated/logs');
    fs.mkdirSync(convLogsDir, { recursive: true });

    const steps = [
      { step_index: 0, type: 'USER_INPUT', content: 'Fix the bug in player' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'view_file' }],
        content: "I'll inspect the player file now.",
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command' }],
        content: "Running test suite to verify failure.",
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [],
        content: '# Bug Fixed\n\nWe updated `playback-engine.ts` to properly handle negative offsets and all tests pass.',
      },
    ];

    fs.writeFileSync(
      path.join(convLogsDir, 'transcript.jsonl'),
      steps.map((s) => JSON.stringify(s)).join('\n'),
      'utf8'
    );

    const service = new SessionCatalogService({ brainDir, library });
    const turns = service.getSessionTurns(convId);

    // Only 1 substantive turn should be surfaced!
    expect(turns.length).toBe(1);
    const turn = turns[0];
    expect(turn.stepIndex).toBe(3);
    expect(turn.title).toBe('Bug Fixed');
    expect(turn.foldedStepCount).toBe(2);
    expect(turn.foldedSteps?.length).toBe(2);
    expect(turn.foldedSteps?.[0].content).toBe("I'll inspect the player file now.");
    expect(turn.foldedSteps?.[1].content).toBe("Running test suite to verify failure.");
  });
});
