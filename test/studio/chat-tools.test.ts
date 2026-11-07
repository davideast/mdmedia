import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Caller } from '../../studio/src/lib/api-auth';
import { API_KEY_SCOPES, type ApiKeyScope } from '../../studio/src/lib/api-key-token';
import { CHAT_SLASH_COMMANDS } from '../../studio/src/lib/chat/slash-commands';
import {
  CHAT_TOOLS,
  executeChatToolCall,
  getAllowedToolsForCaller,
  getChatTool,
  toGeminiFunctionDeclarations,
  type ChatToolContext,
} from '../../studio/src/lib/chat/tools';
import {
  isItemAlreadyOpenInView,
  setChatMediaReaderDepsForTests,
} from '../../studio/src/lib/chat/tools/context-tools';
import type { ActiveViewContext } from '../../studio/src/lib/chat/types';
import { MediaError } from '../../studio/src/lib/image-request';
import type { AnalysisResource } from '../../studio/src/lib/media-types';
import { InMemoryTreeStore } from '../../studio/src/lib/tree-fakes';
import { setServerTreeStoreForTests } from '../../studio/src/lib/trees-server';

const VALID_SCOPE_SET = new Set<string>(API_KEY_SCOPES);

function makeCtx(overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    caller: { kind: 'user', uid: 'user_alice', email: 'alice@example.com' },
    origin: 'https://studio.example.com',
    threadId: 'thr_test_1',
    messageId: 'msg_asst_1',
    callId: 'call_test_1',
    viewContext: null,
    confirmedByUser: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('Studio Contextual Chat — Declarative Tool Registry & Schemas', () => {
  it('defines unique tool names, valid JSON Schema object parameters, and valid ApiKeyScopes', () => {
    expect(CHAT_TOOLS.length).toBeGreaterThanOrEqual(17);

    const seenNames = new Set<string>();
    for (const tool of CHAT_TOOLS) {
      expect(seenNames.has(tool.name)).toBe(false);
      seenNames.add(tool.name);

      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(tool.runningLabel.trim().length).toBeGreaterThan(3);
      expect(tool.description.trim().length).toBeGreaterThan(10);
      expect(['context', 'action']).toContain(tool.kind);
      expect(['auto-read', 'client-immediate', 'staged-confirm', 'immediate-write']).toContain(tool.policy);

      expect(tool.requiredScopes.length).toBeGreaterThanOrEqual(1);
      for (const scope of tool.requiredScopes) {
        expect(VALID_SCOPE_SET.has(scope)).toBe(true);
      }

      expect(tool.parameters.type).toBe('object');
      expect(typeof tool.parameters.properties).toBe('object');
      expect(Array.isArray(tool.parameters.properties)).toBe(false);

      if (tool.parameters.required) {
        for (const reqKey of tool.parameters.required) {
          expect(Object.prototype.hasOwnProperty.call(tool.parameters.properties, reqKey)).toBe(true);
        }
      }
    }

    const declarations = toGeminiFunctionDeclarations(CHAT_TOOLS);
    expect(declarations).toHaveLength(CHAT_TOOLS.length);
    for (const decl of declarations) {
      expect(decl.type).toBe('function');
      expect(typeof decl.name).toBe('string');
      expect(decl.parameters?.type).toBe('object');
    }
  });

  it('binds every non-client-only slash command to a registered chat tool', () => {
    for (const cmd of CHAT_SLASH_COMMANDS) {
      if (cmd.pinMode === 'client-only') {
        expect(cmd.toolName).toBeNull();
        continue;
      }
      expect(cmd.toolName).toBeTruthy();
      const tool = getChatTool(cmd.toolName);
      expect(tool).not.toBeNull();
      expect(tool?.slashCommand).toBe(cmd.command);
    }
  });
});

describe('Studio Contextual Chat — API Key Scope Isolation', () => {
  const readOnlyAnalysisCaller: Caller = {
    kind: 'apiKey',
    uid: 'user_alice',
    keyId: 'key_ro_1',
    scopes: ['chat:use', 'analyses:read'] as ApiKeyScope[],
  };

  beforeEach(() => {
    const fakeAnalysis: AnalysisResource = {
      id: 'ana_keynote_1',
      type: 'analysis',
      title: 'Keynote Q&A Breakdown',
      status: 'ready',
      visibility: 'private',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      href: '/analysis/ana_keynote_1',
      thumbnailAssetId: null,
      sourcePreview: 'Preview of keynote analysis',
      request: {
        prompt: 'List key product announcements with timestamps.',
        source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        model: 'gemini-3.8-flash',
        processing: { mode: 'agentic', startSeconds: null, endSeconds: null, fps: null },
        mediaResolution: null,
        systemInstruction: null,
        responseSchema: null,
        previousInteractionId: null,
      },
      latestGenerationId: 'gen_ana_1',
      latestSuccessfulGenerationId: 'gen_ana_1',
      latestGeneration: {
        id: 'gen_ana_1',
        itemId: 'ana_keynote_1',
        type: 'analysis',
        title: 'Keynote Q&A Breakdown',
        status: 'ready',
        phase: 'ready',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_010_000,
        request: {
          prompt: 'List key product announcements with timestamps.',
          source: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          model: 'gemini-3.8-flash',
          processing: { mode: 'agentic', startSeconds: null, endSeconds: null, fps: null },
          mediaResolution: null,
          systemInstruction: null,
          responseSchema: null,
          previousInteractionId: null,
        },
        preparedPrompt: null,
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        interactionId: 'int_1',
        progress: null,
        usage: null,
        trace: [],
        narrationId: null,
        narrationError: null,
        assets: [],
        error: null,
        links: {
          self: 'https://studio.example.com/api/v1/generations/gen_ana_1',
          web: 'https://studio.example.com/analysis/ana_keynote_1',
        },
      },
      result: null,
      links: {
        self: 'https://studio.example.com/api/v1/analyses/ana_keynote_1',
        web: 'https://studio.example.com/analysis/ana_keynote_1',
        generations: 'https://studio.example.com/api/v1/analyses/ana_keynote_1/generations',
      },
    };

    setChatMediaReaderDepsForTests({
      async analysisResource(uid, id) {
        if (uid !== 'user_alice' || id !== 'ana_keynote_1') {
          throw new MediaError(404, 'not_found', 'That analysis is not available to you.');
        }
        return fakeAnalysis;
      },
      async loadAnalysisAnswerText(_uid, generationId) {
        if (generationId === 'gen_ana_1') {
          return '# Keynote Summary\n\n- 00:45 Studio Contextual Chat announced.\n- 04:12 Tree reader demo.';
        }
        return '';
      },
      async listMedia(caller) {
        if (caller.uid !== 'user_alice') return { items: [], indexing: false };
        return {
          indexing: false,
          items: [
            {
              id: 'ana_keynote_1',
              type: 'analysis',
              title: 'Keynote Q&A Breakdown',
              status: 'ready',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_010_000,
              href: '/analysis/ana_keynote_1',
              thumbnailAssetId: null,
              sourcePreview: 'Studio Contextual Chat announced',
            },
          ],
        };
      },
    });
  });

  afterEach(() => {
    setChatMediaReaderDepsForTests(null);
    setServerTreeStoreForTests(null);
  });

  it('allows read-only analysis tools and rejects ungranted media/write tools for scoped API keys', async () => {
    const allowed = getAllowedToolsForCaller(readOnlyAnalysisCaller).map((t) => t.name);
    expect(allowed).toContain('get_active_view_context');
    expect(allowed).toContain('read_media_item');
    expect(allowed).toContain('search_library');
    expect(allowed).not.toContain('generate_video');
    expect(allowed).not.toContain('upsert_tree_document');
    expect(allowed).not.toContain('analyze_video');

    const activeView: ActiveViewContext = {
      surface: 'analysis',
      route: '/analysis/ana_keynote_1',
      itemId: 'ana_keynote_1',
      title: 'Keynote Q&A Breakdown',
      status: 'ready',
      sourceYoutubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      playheadSeconds: 84,
    };

    const viewOutcome = await executeChatToolCall(
      'get_active_view_context',
      {},
      makeCtx({ caller: readOnlyAnalysisCaller, viewContext: activeView }),
    );
    expect(viewOutcome.isError).toBeUndefined();
    expect(viewOutcome.modelSummary.pillLabel).toBe('Analysis · Keynote Q&A Breakdown · 01:24');
    expect((viewOutcome.modelSummary.focusedItem as Record<string, unknown>)?.id).toBe('ana_keynote_1');

    // Allowed: reading an owned analysis with pagination
    const readAnalysis = await executeChatToolCall(
      'read_media_item',
      { uri: 'mdmedia://analysis/ana_keynote_1', offset: 0, limit: 35 },
      makeCtx({ caller: readOnlyAnalysisCaller }),
    );
    expect(readAnalysis.isError).toBeUndefined();
    expect(readAnalysis.modelSummary.answer).toBe('# Keynote Summary\n\n- 00:45 Studio C');
    expect(readAnalysis.modelSummary.hasMore).toBe(true);
    expect(readAnalysis.modelSummary.nextOffset).toBe(35);
    expect(readAnalysis.uiParts?.[0]?.kind).toBe('media-embed');

    // Rejected: reading a video without videos:read scope
    const readVideo = await executeChatToolCall(
      'read_media_item',
      { uri: 'mdmedia://video/vid_secret' },
      makeCtx({ caller: readOnlyAnalysisCaller }),
    );
    expect(readVideo.isError).toBe(true);
    expect(readVideo.modelSummary.error).toBe('insufficient_scope');

    // Allowed: searching library within granted analyses:read scope
    const searchRes = await executeChatToolCall(
      'search_library',
      { query: 'Keynote' },
      makeCtx({ caller: readOnlyAnalysisCaller }),
    );
    expect(searchRes.isError).toBeUndefined();
    expect(searchRes.modelSummary.count).toBe(1);
    expect(searchRes.uiParts?.[0]).toMatchObject({
      kind: 'media-embed',
      mediaType: 'analysis',
      itemId: 'ana_keynote_1',
    });

    // Rejected: generate_video and upsert_tree_document
    const genVideo = await executeChatToolCall(
      'generate_video',
      { prompt: 'Aerial drone shot over snowy peaks' },
      makeCtx({ caller: readOnlyAnalysisCaller }),
    );
    expect(genVideo.isError).toBe(true);
    expect(genVideo.modelSummary.error).toBe('insufficient_scope');

    const upsertDoc = await executeChatToolCall(
      'upsert_tree_document',
      { treeId: 't_1', path: 'notes.md', markdown: '# Hacked' },
      makeCtx({ caller: readOnlyAnalysisCaller }),
    );
    expect(upsertDoc.isError).toBe(true);
    expect(upsertDoc.modelSummary.error).toBe('insufficient_scope');
  });
});

describe('Studio Contextual Chat — Tree Context & Staged Document Tools', () => {
  let treeStore: InMemoryTreeStore;
  let treeId: string;

  beforeEach(async () => {
    treeStore = new InMemoryTreeStore('user_alice');
    setServerTreeStoreForTests(treeStore);

    const created = await treeStore.createTree('user_alice', {
      title: 'Product Launch',
      ops: [
        {
          op: 'put_doc',
          path: 'docs/launch-plan.md',
          title: 'Launch Plan',
          markdown: [
            '# Launch Plan',
            '',
            '## Overview',
            'Initial launch overview with ![Hero](mdmedia://image/img_hero_1) and [Analysis](mdmedia://analysis/ana_99).',
            '',
            '## Timeline',
            '- Week 1: Beta',
            '- Week 2: GA',
          ].join('\n'),
        },
      ],
    });
    treeId = created.id;
  });

  afterEach(() => {
    setServerTreeStoreForTests(null);
  });

  it('reads tree documents with offset/limit pagination, section extraction, and mdmedia:// refs', async () => {
    const viewContext: ActiveViewContext = {
      surface: 'tree-doc',
      route: `/trees/${treeId}/docs/launch-plan.md`,
      treeId,
      docPath: 'docs/launch-plan.md',
    };

    const fullOutcome = await executeChatToolCall(
      'read_tree_document',
      { offset: 0, limit: 45 },
      makeCtx({ viewContext }),
    );
    expect(fullOutcome.isError).toBeUndefined();
    expect(fullOutcome.modelSummary.path).toBe('docs/launch-plan.md');
    expect(fullOutcome.modelSummary.hasMore).toBe(true);
    expect(fullOutcome.modelSummary.nextOffset).toBe(45);
    expect((fullOutcome.modelSummary.content as string).length).toBe(45);
    expect(fullOutcome.modelSummary.mediaRefs).toEqual([
      { uri: 'mdmedia://image/img_hero_1', mediaType: 'image', itemId: 'img_hero_1', generationId: null },
      { uri: 'mdmedia://analysis/ana_99', mediaType: 'analysis', itemId: 'ana_99', generationId: null },
    ]);

    const sectionOutcome = await executeChatToolCall(
      'read_tree_document',
      { heading: 'Timeline' },
      makeCtx({ viewContext }),
    );
    expect(sectionOutcome.isError).toBeUndefined();
    expect(sectionOutcome.modelSummary.content).toBe('## Timeline\n- Week 1: Beta\n- Week 2: GA');
  });

  it('stages insert_media_into_document and upsert_tree_document with exact line deltas without mutating the tree store', async () => {
    const beforeDoc = await treeStore.getDocument('user_alice', treeId, 'docs/launch-plan.md');
    const viewContext: ActiveViewContext = {
      surface: 'tree-doc',
      route: `/trees/${treeId}/docs/launch-plan.md`,
      treeId,
      docPath: 'docs/launch-plan.md',
    };

    // 1. Stage media insertion under heading
    const insertRes = await executeChatToolCall(
      'insert_media_into_document',
      {
        mediaType: 'video',
        itemId: 'vid_demo_42',
        title: 'Launch Demo Clip',
        heading: 'Timeline',
        mode: 'after-heading',
      },
      makeCtx({ callId: 'call_insert_1', viewContext }),
    );
    expect(insertRes.isError).toBeUndefined();
    expect(insertRes.modelSummary.mediaMarkdown).toBe('![Launch Demo Clip](mdmedia://video/vid_demo_42)');
    expect((insertRes.modelSummary.lineDelta as { added: number; removed: number }).added).toBeGreaterThan(0);
    expect(insertRes.stagedPayload?.validatedInput.expectedUpdatedAt).toBe(beforeDoc.updatedAt);
    expect(insertRes.uiParts?.[0]).toMatchObject({
      kind: 'action-card',
      callId: 'call_insert_1',
      toolName: 'insert_media_into_document',
      state: 'staged',
    });

    // Verify store was NOT mutated during staging
    const afterInsertStage = await treeStore.getDocument('user_alice', treeId, 'docs/launch-plan.md');
    expect(afterInsertStage.markdown).toBe(beforeDoc.markdown);
    expect(afterInsertStage.updatedAt).toBe(beforeDoc.updatedAt);

    // 2. Stage section replacement via upsert_tree_document
    const upsertRes = await executeChatToolCall(
      'upsert_tree_document',
      {
        mode: 'replace-section',
        sectionHeading: 'Timeline',
        markdown: '## Timeline\n- Week 1: Private Preview\n- Week 2: Public Beta\n- Week 3: GA',
      },
      makeCtx({ callId: 'call_upsert_1', viewContext }),
    );
    expect(upsertRes.isError).toBeUndefined();
    const delta = upsertRes.modelSummary.lineDelta as { added: number; removed: number; summary: string };
    expect(delta).toEqual({ added: 3, removed: 2, summary: '+3 / -2 lines' });
    expect(upsertRes.stagedPayload?.validatedInput.expectedUpdatedAt).toBe(beforeDoc.updatedAt);

    const card = upsertRes.uiParts?.[0];
    expect(card?.kind).toBe('action-card');
    if (card?.kind === 'action-card') {
      expect(card.state).toBe('staged');
      expect(card.cardActions[0]).toEqual({ kind: 'confirm', label: 'Apply edit', primary: true });
      expect(card.cardActions[1]).toMatchObject({ kind: 'open-route', label: 'Open doc' });
    }

    // Store still untouched until user confirms
    const afterUpsertStage = await treeStore.getDocument('user_alice', treeId, 'docs/launch-plan.md');
    expect(afterUpsertStage.markdown).toBe(beforeDoc.markdown);
  });

  it('stages paid media tools using active view defaults and validates inputs without charging quota', async () => {
    const videoView: ActiveViewContext = {
      surface: 'video',
      route: '/video/vid_active_7',
      itemId: 'vid_active_7',
      title: 'Rough Opening',
      status: 'ready',
    };

    const analyzeStaged = await executeChatToolCall(
      'analyze_video',
      { prompt: 'Find every scene cut and speaker change.', mode: 'agentic' },
      makeCtx({ callId: 'call_ana_stage', viewContext: videoView }),
    );
    expect(analyzeStaged.isError).toBeUndefined();
    expect(analyzeStaged.stagedPayload?.validatedInput).toMatchObject({
      analysisBody: {
        prompt: 'Find every scene cut and speaker change.',
        source: { kind: 'video', videoItemId: 'vid_active_7' },
        processing: { mode: 'agentic' },
      },
    });
    expect(analyzeStaged.uiParts?.[0]).toMatchObject({
      kind: 'action-card',
      toolName: 'analyze_video',
      state: 'staged',
      mediaType: 'analysis',
    });

    const narrateStaged = await executeChatToolCall(
      'create_narration',
      { input: 'Welcome to Studio Contextual Chat.', title: 'Intro Clip' },
      makeCtx({ callId: 'call_narr_stage' }),
    );
    expect(narrateStaged.isError).toBeUndefined();
    expect(narrateStaged.uiParts?.[0]).toMatchObject({
      kind: 'action-card',
      toolName: 'create_narration',
      state: 'staged',
      mediaType: 'narration',
    });

    const invalidMusic = await executeChatToolCall(
      'generate_music',
      { prompt: 'Calm ambient synth', instrumental: true, lyrics: 'La la la' },
      makeCtx({ callId: 'call_music_bad' }),
    );
    expect(invalidMusic.isError).toBe(true);
    expect(invalidMusic.modelSummary.error).toBe('conflicting_lyrics');
  });
});

describe('Studio Contextual Chat — Client-Immediate Action Tools', () => {
  it('emits exact clientAction payloads for open_in_studio, seek_media, and prefill_composer_draft', async () => {
    const openUri = await executeChatToolCall(
      'open_in_studio',
      { uri: 'mdmedia://analysis/ana_123' },
      makeCtx(),
    );
    expect(openUri.isError).toBeUndefined();
    expect(openUri.clientAction).toEqual({
      kind: 'open_route',
      href: '/analysis/ana_123',
    });

    const rejectExternal = await executeChatToolCall(
      'open_in_studio',
      { target: 'https://evil.example.com/phish' },
      makeCtx(),
    );
    expect(rejectExternal.isError).toBe(true);

    const seekRes = await executeChatToolCall(
      'seek_media',
      { seconds: 84.5, play: true, label: 'Demo section' },
      makeCtx({
        viewContext: {
          surface: 'video',
          route: '/video/vid_1',
          itemId: 'vid_1',
          title: 'Demo',
        },
      }),
    );
    expect(seekRes.isError).toBeUndefined();
    expect(seekRes.clientAction).toEqual({
      kind: 'seek_media',
      seconds: 84.5,
      play: true,
    });

    const prefillRes = await executeChatToolCall(
      'prefill_composer_draft',
      {
        draftKind: 'image',
        patch: { prompt: 'Minimalist architectural courtyard at dusk', aspectRatio: '16:9' },
      },
      makeCtx(),
    );
    expect(prefillRes.isError).toBeUndefined();
    expect(prefillRes.clientAction).toEqual({
      kind: 'prefill_draft',
      draftKind: 'image',
      href: '/studio/image',
      patch: { prompt: 'Minimalist architectural courtyard at dusk', aspectRatio: '16:9' },
    });
  });
});

describe('Studio Contextual Chat — Suppress Duplicate Embeds for Items Open in Middle Panel', () => {
  afterEach(() => {
    setChatMediaReaderDepsForTests(null);
    setServerTreeStoreForTests(null);
  });

  it('detects items already open across narration, analysis, video, and tree-doc surfaces', () => {
    expect(
      isItemAlreadyOpenInView(
        {
          surface: 'narration',
          route: '/narration/nar_open_1',
          itemId: 'nar_open_1',
          title: 'Weekly Brief',
        },
        'narration',
        'nar_open_1',
      ),
    ).toBe(true);

    expect(
      isItemAlreadyOpenInView(
        {
          surface: 'narration',
          route: '/narration/nar_open_1',
          itemId: 'nar_open_1',
          title: 'Weekly Brief',
        },
        'narration',
        'nar_other_2',
      ),
    ).toBe(false);

    expect(
      isItemAlreadyOpenInView(
        {
          surface: 'analysis',
          route: '/analysis/ana_open_1',
          itemId: 'ana_open_1',
          title: 'Rough Cut Review',
          sourceVideoId: 'vid_source_9',
        },
        'video',
        'vid_source_9',
      ),
    ).toBe(true);

    expect(
      isItemAlreadyOpenInView(
        {
          surface: 'tree-doc',
          route: '/trees/t1/intro.md',
          treeId: 't1',
          docPath: 'intro.md',
        },
        'narration',
        'nar_tree_bound',
        'nar_tree_bound',
      ),
    ).toBe(true);
  });

  it('omits redundant media-embed uiParts when read_media_item reads the item already open in viewContext, while emitting media-embed for external items', async () => {
    setChatMediaReaderDepsForTests({
      async loadOwnedNarration(uid, id) {
        if (uid !== 'user_alice') {
          throw new MediaError(404, 'not_found', 'Not found');
        }
        return {
          id,
          ownerUid: 'user_alice',
          authorName: 'Alice',
          authorPhoto: '',
          title: `Narration ${id}`,
          sourceMarkdown: '# Notes\n\nDetailed transcript body.',
          transcript: 'Notes. Detailed transcript body.',
          adapted: false,
          voice: 'Sulafat',
          promptStyle: '',
          durationMs: id === 'nar_other_2' ? 24_000 : 18_000,
          status: 'ready',
          visibility: 'private',
          audioPath: `narrations/user_alice/${id}.wav`,
          timingsPath: `narrations/user_alice/${id}.timings.json`,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_005_000,
        };
      },
      async listMedia() {
        return {
          indexing: false,
          items: [
            {
              id: 'nar_open_1',
              type: 'narration',
              title: 'Narration nar_open_1',
              status: 'ready',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_005_000,
              href: '/narration/nar_open_1',
              thumbnailAssetId: null,
              durationMs: 18_000,
            },
            {
              id: 'nar_other_2',
              type: 'narration',
              title: 'Narration nar_other_2',
              status: 'ready',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_005_000,
              href: '/narration/nar_other_2',
              thumbnailAssetId: null,
              durationMs: 24_000,
            },
          ],
        };
      },
    });

    const openNarrationView: ActiveViewContext = {
      surface: 'narration',
      route: '/narration/nar_open_1',
      itemId: 'nar_open_1',
      title: 'Narration nar_open_1',
    };

    // Reading the narration already open in the middle panel returns full content with ZERO duplicate media-embed
    const sameItemOutcome = await executeChatToolCall(
      'read_media_item',
      { uri: 'mdmedia://narration/nar_open_1' },
      makeCtx({ viewContext: openNarrationView }),
    );
    expect(sameItemOutcome.isError).toBeUndefined();
    expect((sameItemOutcome.modelSummary as { content?: string }).content).toContain(
      'Detailed transcript body.',
    );
    expect(sameItemOutcome.uiParts).toBeUndefined();

    // Reading a DIFFERENT narration while nar_open_1 is open still attaches media-embed
    const differentItemOutcome = await executeChatToolCall(
      'read_media_item',
      { uri: 'mdmedia://narration/nar_other_2' },
      makeCtx({ viewContext: openNarrationView }),
    );
    expect(differentItemOutcome.uiParts).toEqual([
      {
        kind: 'media-embed',
        mediaType: 'narration',
        itemId: 'nar_other_2',
        title: 'Narration nar_other_2',
        subtitle: '00:24 · Sulafat',
      },
    ]);

    // Searching library while nar_open_1 is open excludes nar_open_1 from media-embed cards
    const searchOutcome = await executeChatToolCall(
      'search_library',
      { type: 'narration' },
      makeCtx({ viewContext: openNarrationView }),
    );
    const embedIds = (searchOutcome.uiParts ?? [])
      .filter((p) => p.kind === 'media-embed')
      .map((p) => p.itemId);
    expect(embedIds).toEqual(['nar_other_2']);
  });

  it('stages image revisions (`refine`), new versions (`regenerate`), and video/music versions on existing items', async () => {
    const activeImageView: ActiveViewContext = {
      surface: 'image',
      route: '/image/img_skyline_1',
      itemId: 'img_skyline_1',
      title: 'Intaglio Skyline in Crimson',
      status: 'ready',
      generationId: 'gen_skyline_v1',
    };

    // 1. Revision (`refine`) using canonical mdmedia:// URI + active view generationId
    const refineOutcome = await executeChatToolCall(
      'generate_image',
      {
        prompt: 'Keep the copperplate skyline identical, but make the crimson building half as tall and add river boats.',
        targetItemId: 'mdmedia://image/img_skyline_1',
        action: 'refine',
      },
      makeCtx({ viewContext: activeImageView }),
    );
    expect(refineOutcome.isError).toBeUndefined();
    expect(refineOutcome.modelSummary).toMatchObject({
      staged: true,
      targetItemId: 'img_skyline_1',
      deliveryMode: 'refine',
      fromGenerationId: 'gen_skyline_v1',
    });
    expect(refineOutcome.stagedPayload?.targetRoute).toBe('/image/img_skyline_1');
    expect(refineOutcome.stagedPayload?.validatedInput).toMatchObject({
      targetItemId: 'img_skyline_1',
      deliveryMode: 'refine',
      fromGenerationId: 'gen_skyline_v1',
      imageBody: {
        action: 'refine',
        fromGenerationId: 'gen_skyline_v1',
      },
    });
    expect(refineOutcome.uiParts?.[0]).toMatchObject({
      kind: 'action-card',
      toolName: 'generate_image',
      state: 'staged',
      itemId: 'img_skyline_1',
      revisionTarget: {
        itemId: 'img_skyline_1',
        fromGenerationId: 'gen_skyline_v1',
        defaultMode: 'refine',
        supportedModes: ['refine', 'regenerate', 'new_item'],
      },
    });
    const refineCard = refineOutcome.uiParts?.[0];
    if (refineCard?.kind === 'action-card') {
      expect(refineCard.meta).toContain('Revision · ');
      expect(refineCard.cardActions[0]).toMatchObject({
        kind: 'confirm',
        label: 'Generate revision',
      });
    }

    // 2. New version (`regenerate`) on the same image item without locking parentGenerationId
    const regenOutcome = await executeChatToolCall(
      'generate_image',
      {
        prompt: 'Wide dusk copperplate skyline with a single crimson lighthouse on the pier.',
        targetItemId: 'img_skyline_1',
        action: 'regenerate',
        aspectRatio: '4:3',
      },
      makeCtx({ viewContext: activeImageView }),
    );
    expect(regenOutcome.isError).toBeUndefined();
    expect(regenOutcome.modelSummary).toMatchObject({
      staged: true,
      targetItemId: 'img_skyline_1',
      deliveryMode: 'regenerate',
      aspectRatio: '4:3',
    });
    const regenBody = regenOutcome.stagedPayload?.validatedInput.imageBody as Record<string, unknown>;
    expect(regenBody.action).toBe('regenerate');
    expect(regenBody.fromGenerationId).toBeUndefined();

    // 3. Auto-binds `targetItemId` from active `/image/[id]` view when `action: "refine"` omits `targetItemId`
    const implicitViewRefine = await executeChatToolCall(
      'generate_image',
      {
        prompt: 'Add subtle cross-hatched clouds above the skyline.',
        action: 'refine',
      },
      makeCtx({ viewContext: activeImageView }),
    );
    expect(implicitViewRefine.isError).toBeUndefined();
    expect(implicitViewRefine.modelSummary.targetItemId).toBe('img_skyline_1');

    // 4. Rejects `action: "refine"` when neither `targetItemId` nor an active image view is present
    const missingTarget = await executeChatToolCall(
      'generate_image',
      {
        prompt: 'Make the building taller.',
        action: 'refine',
      },
      makeCtx({ viewContext: null }),
    );
    expect(missingTarget.isError).toBe(true);
    expect(missingTarget.modelSummary.error).toBe('missing_target_item');

    // 5. Video continuation (`continue`) and Music new version (`targetItemId`)
    const videoCont = await executeChatToolCall(
      'generate_video',
      {
        prompt: 'Camera tracks forward across the harbor water.',
        targetItemId: 'mdmedia://video/vid_harbor_1',
        action: 'continue',
        durationSeconds: 6,
      },
      makeCtx(),
    );
    expect(videoCont.isError).toBeUndefined();
    expect(videoCont.modelSummary).toMatchObject({
      targetItemId: 'vid_harbor_1',
      deliveryMode: 'refine',
    });

    const musicVer = await executeChatToolCall(
      'generate_music',
      {
        prompt: 'Solo cello variation at a slower tempo.',
        targetItemId: 'mdmedia://music/mus_theme_1',
        instrumental: true,
      },
      makeCtx(),
    );
    expect(musicVer.isError).toBeUndefined();
    expect(musicVer.modelSummary).toMatchObject({
      targetItemId: 'mus_theme_1',
      deliveryMode: 'regenerate',
    });
  });
});
