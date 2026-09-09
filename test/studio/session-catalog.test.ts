import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioLibrary } from '../../src/storage/audio-library.js';
import { SessionCatalogService } from '../../src/studio/session-catalog.js';

describe('SessionCatalogService (Seam 1)', () => {
  let tempDir: string;
  let brainDir: string;
  let libraryDir: string;
  let library: AudioLibrary;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `mdmedia_test_session_catalog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    brainDir = path.join(tempDir, 'brain');
    libraryDir = path.join(tempDir, 'audio_library');
    fs.mkdirSync(brainDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });

    library = new AudioLibrary(libraryDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('discovers PLANNER_RESPONSE turns from transcript.jsonl and cross-references cached AudioLibrary tracks', async () => {
    const convId = 'ac52ca05-0fde-4734-a358-0b39f77b9c97';
    const convLogsDir = path.join(brainDir, convId, '.system_generated/logs');
    fs.mkdirSync(convLogsDir, { recursive: true });

    const steps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content: 'Please refactor PlaybackEngine',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'view_file' }],
        content: '', // Intermediate tool-call step with no speakable response
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-08T12:00:00Z',
        content: '# Refactoring PlaybackEngine\n\nWe added a history stack for prev() navigation.',
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-08T12:05:00Z',
        content: '# Next Steps\n\nAll tests pass cleanly.',
      },
    ];

    fs.writeFileSync(
      path.join(convLogsDir, 'transcript.jsonl'),
      steps.map((s) => JSON.stringify(s)).join('\n'),
      'utf8'
    );

    // Save audio track for step 2 in AudioLibrary
    await library.saveTrack({
      sessionId: convId,
      stepIndex: 2,
      markdown: '# Refactoring PlaybackEngine\n\nWe added a history stack for prev() navigation.',
      audioBuffer: new Uint8Array(44 + 4800),
      voice: 'Puck',
    });

    const service = new SessionCatalogService({ brainDir, library });
    const turns = service.listSessionTurns();

    // Should only include user-facing PLANNER_RESPONSE turns (steps 2 and 3), sorted newest first
    expect(turns.length).toBe(2);

    const turn3 = turns[0];
    expect(turn3.stepIndex).toBe(3);
    expect(turn3.title).toBe('Next Steps');
    expect(turn3.status).toBe('ungenerated');
    expect(turn3.track).toBeUndefined();
    expect(turn3.wordCount).toBe(6);

    const turn2 = turns[1];
    expect(turn2.stepIndex).toBe(2);
    expect(turn2.title).toBe('Refactoring PlaybackEngine');
    expect(turn2.status).toBe('cached');
    expect(turn2.track).toBeDefined();
    expect(turn2.track?.id).toBe('ac52ca05_s2');
  });

  it('filters turns by audioOnly and query string across title and markdown body', async () => {
    const convId = 'ac52ca05-0fde-4734-a358-0b39f77b9c97';
    const convLogsDir = path.join(brainDir, convId, '.system_generated/logs');
    fs.mkdirSync(convLogsDir, { recursive: true });

    const steps = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: '# Alpha Architecture\n\nDetailed design for the streaming pipeline.',
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        content: '# Beta Release\n\nDeployment checklist for production.',
      },
    ];

    fs.writeFileSync(
      path.join(convLogsDir, 'transcript.jsonl'),
      steps.map((s) => JSON.stringify(s)).join('\n'),
      'utf8'
    );

    await library.saveTrack({
      sessionId: convId,
      stepIndex: 1,
      markdown: steps[0].content,
      audioBuffer: new Uint8Array(44 + 4800),
      voice: 'Puck',
    });

    const service = new SessionCatalogService({ brainDir, library });

    const audioOnlyTurns = service.listSessionTurns({ audioOnly: true });
    expect(audioOnlyTurns.length).toBe(1);
    expect(audioOnlyTurns[0].title).toBe('Alpha Architecture');

    const queryTurns = service.listSessionTurns({ query: 'checklist' });
    expect(queryTurns.length).toBe(1);
    expect(queryTurns[0].title).toBe('Beta Release');
  });

  it('discovers workspace *.narration.md files alongside transcript turns', async () => {
    const workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true });

    const docContent =
      '# Audio Pipeline Overview\n\nThis script explains the live streaming audio architecture.';
    fs.writeFileSync(
      path.join(workspaceDir, 'docs', 'pipeline.narration.md'),
      docContent,
      'utf8'
    );

    const service = new SessionCatalogService({
      brainDir,
      workspaceDir,
      library,
    });

    const items = service.listSessionTurns();
    expect(items.length).toBe(1);
    expect(items[0].source).toBe('document');
    expect(items[0].title).toBe('[DOC] Audio Pipeline Overview');
    expect(items[0].status).toBe('ungenerated');
    expect(items[0].filePath).toContain('pipeline.narration.md');
  });
});
