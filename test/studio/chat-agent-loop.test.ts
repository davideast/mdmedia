import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Interactions } from '@google/genai';
import type { Caller } from '../../studio/src/lib/api-auth';
import {
  buildRecentThreadMediaPromptBlock,
  createChatTurnSseStream,
  extractThoughtHeadline,
  formatSseEvent,
  parseSseFrames,
  runChatTurn,
  type ChatInteractionsClient,
} from '../../studio/src/lib/chat/chat-agent-server';
import {
  ChatConfirmError,
  confirmStagedChatAction,
} from '../../studio/src/lib/chat/chat-confirm-server';
import {
  createInMemoryChatStore,
  setChatStoreForTests,
  type ChatStorePort,
} from '../../studio/src/lib/chat/chat-store-server';
import { setChatMediaReaderDepsForTests } from '../../studio/src/lib/chat/tools/context-tools';
import type { ActiveViewContext } from '../../studio/src/lib/chat/types';
import { InMemoryTreeStore } from '../../studio/src/lib/tree-fakes';
import { setServerTreeStoreForTests } from '../../studio/src/lib/trees-server';

const ALICE: Caller = { kind: 'user', uid: 'user_alice', email: 'alice@example.com' };
const BOB: Caller = { kind: 'user', uid: 'user_bob', email: 'bob@example.com' };

describe('Studio Contextual Chat — Multi-Step Agent Loop & Confirmation', () => {
  let chatStore: ChatStorePort;
  let treeStore: InMemoryTreeStore;
  let treeId: string;

  beforeEach(async () => {
    chatStore = createInMemoryChatStore();
    setChatStoreForTests(chatStore);

    treeStore = new InMemoryTreeStore('user_alice');
    setServerTreeStoreForTests(treeStore);

    const tree = await treeStore.createTree('user_alice', {
      title: 'Architecture Docs',
      ops: [
        {
          op: 'put_doc',
          path: 'rfcs/chat-spec.md',
          title: 'Chat Spec',
          markdown: '# Chat Spec\n\n## Goals\nKeep the right column calm and contextual.',
        },
      ],
    });
    treeId = tree.id;
  });

  afterEach(() => {
    setChatStoreForTests(null);
    setServerTreeStoreForTests(null);
  });

  it('extracts bold headlines and clean first lines from thought summaries', () => {
    expect(extractThoughtHeadline('**Inspecting active tree document**\nChecking headings first.')).toBe(
      'Inspecting active tree document',
    );
    expect(extractThoughtHeadline('  # Reviewing video timestamps  \nMore text')).toBe(
      'Reviewing video timestamps',
    );
    expect(extractThoughtHeadline('   ')).toBeNull();
  });

  it('executes a multi-step turn: thought_summary -> function_call (read_tree_document) -> function_result -> final text + persisted message', async () => {
    const recordedRequests: Array<Record<string, unknown>> = [];

    const mockClient: ChatInteractionsClient = {
      async create(params) {
        recordedRequests.push(structuredClone(params));
        const callIndex = recordedRequests.length;

        if (callIndex === 1) {
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'interaction.created',
              interaction: { id: 'int_step_0', status: 'in_progress' },
            };
            yield {
              event_type: 'step.delta',
              index: 0,
              delta: {
                type: 'thought_summary',
                content: { type: 'text', text: '**Reading active spec**\nLet me read `rfcs/chat-spec.md` first.' },
              } as unknown as Interactions.StepDelta['delta'],
            };
            yield {
              event_type: 'step.stop',
              index: 0,
            };
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_step_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_read_doc_1',
                    name: 'read_tree_document',
                    arguments: {},
                  },
                ],
              },
            };
          })();
        }

        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'interaction.created',
            interaction: { id: 'int_step_1', status: 'in_progress' },
          };
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'The spec’s primary goal is ' },
          };
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'keeping the right column calm and contextual.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_step_1', status: 'completed', steps: [] },
          };
        })();
      },
    };

    const viewContext: ActiveViewContext = {
      surface: 'tree-doc',
      route: `/trees/${treeId}/rfcs/chat-spec.md`,
      treeId,
      treeTitle: 'Architecture Docs',
      docPath: 'rfcs/chat-spec.md',
      docTitle: 'Chat Spec',
    };

    // Exercise SSE framing stream + parser end-to-end
    const sseStream = createChatTurnSseStream({
      caller: ALICE,
      threadId: 'thr_multi_1',
      text: 'What is the main goal in this doc?',
      viewContext,
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    const rawSse = await new Response(sseStream).text();
    const events = parseSseFrames(rawSse);

    expect(recordedRequests).toHaveLength(2);
    expect(String(recordedRequests[0]!.input)).toContain('[Active Studio View]');
    expect(String(recordedRequests[0]!.input)).toContain('docPath: rfcs/chat-spec.md');

    // Step 1 receives `previous_interaction_id` + `function_result`
    expect(recordedRequests[1]!.previous_interaction_id).toBe('int_step_0');
    const step1Input = recordedRequests[1]!.input as Array<Record<string, unknown>>;
    expect(Array.isArray(step1Input)).toBe(true);
    expect(step1Input[0]).toMatchObject({
      type: 'function_result',
      call_id: 'call_read_doc_1',
      name: 'read_tree_document',
    });
    expect((step1Input[0]!.result as Record<string, unknown>).content).toContain(
      'Keep the right column calm and contextual.',
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('turn.start');
    expect(eventTypes).toContain('thought.delta');
    expect(eventTypes).toContain('thought.done');
    expect(eventTypes).toContain('tool.start');
    expect(eventTypes).toContain('tool.result');
    expect(eventTypes).toContain('text.delta');
    expect(eventTypes.at(-1)).toBe('turn.done');

    const storedThread = await chatStore.getThread(ALICE.uid, 'thr_multi_1');
    expect(storedThread?.lastInteractionId).toBe('int_step_1');
    expect(storedThread?.messageCount).toBe(2);

    const messages = await chatStore.listMessages(ALICE.uid, 'thr_multi_1');
    expect(messages).toHaveLength(2);
    const assistantMsg = messages[1]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.text).toBe('The spec’s primary goal is keeping the right column calm and contextual.');
    expect(assistantMsg.thoughtSummary?.steps).toEqual(['Reading active spec']);
    expect(assistantMsg.interactionId).toBe('int_step_1');
  });

  it('pins /analyze tool_choice to ["analyze_video"] on Step 0 and reverts to "auto" on Step 1', async () => {
    const recordedConfigs: Array<Record<string, unknown>> = [];

    const mockClient: ChatInteractionsClient = {
      async create(params) {
        recordedConfigs.push(structuredClone(params.generation_config as Record<string, unknown>));
        const step = recordedConfigs.length;

        if (step === 1) {
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_ana_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_analyze_99',
                    name: 'analyze_video',
                    arguments: {
                      prompt: 'Summarize speaker transitions',
                      youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                    },
                  },
                ],
              },
            };
          })();
        }

        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'I’ve staged the video analysis card—click **Run analysis** whenever ready.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_ana_1', status: 'completed', steps: [] },
          };
        })();
      },
    };

    const turn = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_slash_1',
      text: '/analyze Summarize speaker transitions on https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    expect(recordedConfigs).toHaveLength(2);
    expect(recordedConfigs[0]!.tool_choice).toEqual({
      allowed_tools: {
        mode: 'any',
        tools: ['analyze_video'],
      },
    });
    expect(recordedConfigs[1]!.tool_choice).toBe('auto');

    expect(turn.assistantMessage?.resultParts?.[0]).toMatchObject({
      kind: 'action-card',
      callId: 'call_analyze_99',
      toolName: 'analyze_video',
      state: 'staged',
    });

    const staged = await chatStore.getStagedAction(ALICE.uid, 'call_analyze_99');
    expect(staged?.state).toBe('staged');
  });

  it('confirms staged actions idempotently—executing the underlying mutation only once across duplicate calls', async () => {
    // 1. Stage both a media action (`analyze_video`) and a tree doc edit (`upsert_tree_document`) in a turn
    let stepCount = 0;
    const mockClient: ChatInteractionsClient = {
      async create() {
        stepCount += 1;
        if (stepCount === 1) {
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_stage_both_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_stage_doc_1',
                    name: 'upsert_tree_document',
                    arguments: {
                      treeId,
                      path: 'rfcs/chat-spec.md',
                      mode: 'append',
                      markdown: '## Rollout\nShip behind progressive verification.',
                    },
                  },
                  {
                    type: 'function_call',
                    id: 'call_stage_vid_1',
                    name: 'generate_video',
                    arguments: {
                      prompt: 'Quiet morning light across an editorial desk',
                      durationSeconds: 6,
                      aspectRatio: '16:9',
                    },
                  },
                ],
              },
            };
          })();
        }
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Both actions are staged below.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_stage_both_1', status: 'completed', steps: [] },
          };
        })();
      },
    };

    await runChatTurn({
      caller: ALICE,
      threadId: 'thr_confirm_1',
      text: 'Append a Rollout section and stage a 6s b-roll clip',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    // Cross-user isolation: Bob cannot confirm Alice's staged action
    await expect(
      confirmStagedChatAction({
        caller: BOB,
        callId: 'call_stage_doc_1',
        origin: 'https://studio.example.com',
        signal: new AbortController().signal,
        store: chatStore,
        treeStore,
      }),
    ).rejects.toBeInstanceOf(ChatConfirmError);

    // Confirm tree document edit twice -> applies once and upgrades persisted action-card to `succeeded`
    const firstDocConfirm = await confirmStagedChatAction({
      caller: ALICE,
      callId: 'call_stage_doc_1',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      treeStore,
    });
    expect(firstDocConfirm.replayed).toBe(false);
    expect(firstDocConfirm.action.state).toBe('submitted');
    expect(firstDocConfirm.card?.state).toBe('succeeded');

    const updatedDoc = await treeStore.getDocument('user_alice', treeId, 'rfcs/chat-spec.md');
    expect(updatedDoc.markdown).toContain('## Rollout\nShip behind progressive verification.');

    const secondDocConfirm = await confirmStagedChatAction({
      caller: ALICE,
      callId: 'call_stage_doc_1',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      treeStore,
    });
    expect(secondDocConfirm.replayed).toBe(true);
    expect(secondDocConfirm.card?.state).toBe('succeeded');

    // Confirm paid video generation twice (concurrently + sequentially) -> executor runs ONCE!
    let videoExecutions = 0;
    const customExecutors = {
      async generate_video({ idempotencyKey }: { idempotencyKey: string }) {
        videoExecutions += 1;
        expect(idempotencyKey).toBe('chat:call_stage_vid_1');
        await new Promise((r) => setTimeout(r, 15));
        return {
          cardState: 'queued' as const,
          generationId: 'gen_vid_777',
          itemId: 'vid_item_777',
          targetRoute: '/video/vid_item_777',
          progressMessage: 'Queued video generation…',
          cardActions: [{ kind: 'open-route' as const, label: 'Open video', href: '/video/vid_item_777' }],
        };
      },
    };

    const [concurrentA, concurrentB] = await Promise.all([
      confirmStagedChatAction({
        caller: ALICE,
        callId: 'call_stage_vid_1',
        origin: 'https://studio.example.com',
        signal: new AbortController().signal,
        store: chatStore,
        treeStore,
        executors: customExecutors,
      }),
      confirmStagedChatAction({
        caller: ALICE,
        callId: 'call_stage_vid_1',
        origin: 'https://studio.example.com',
        signal: new AbortController().signal,
        store: chatStore,
        treeStore,
        executors: customExecutors,
      }),
    ]);

    const sequentialC = await confirmStagedChatAction({
      caller: ALICE,
      callId: 'call_stage_vid_1',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      treeStore,
      executors: customExecutors,
    });

    expect(videoExecutions).toBe(1);
    expect(concurrentA.action.generationId).toBe('gen_vid_777');
    expect(concurrentB.action.generationId).toBe('gen_vid_777');
    expect(sequentialC.replayed).toBe(true);
    expect(sequentialC.card?.state).toBe('queued');
    expect(sequentialC.card?.generationId).toBe('gen_vid_777');

    // Persisted message inside chatStore also reflects upgraded action-card states
    const persistedMessages = await chatStore.listMessages(ALICE.uid, 'thr_confirm_1');
    const persistedCards = persistedMessages[1]!.resultParts ?? [];
    expect(persistedCards).toHaveLength(2);
    expect(persistedCards[0]).toMatchObject({ kind: 'action-card', callId: 'call_stage_doc_1', state: 'succeeded' });
    expect(persistedCards[1]).toMatchObject({
      kind: 'action-card',
      callId: 'call_stage_vid_1',
      state: 'queued',
      generationId: 'gen_vid_777',
      itemId: 'vid_item_777',
    });
  });

  it('transparently falls back to compact transcript replay when previous_interaction_id returns 404 on Step 0', async () => {
    // Seed an existing thread with prior messages and an expired `lastInteractionId`
    await chatStore.createThread(ALICE.uid, { id: 'thr_expired_1', title: 'Earlier Session' });
    await chatStore.appendMessage(ALICE.uid, 'thr_expired_1', {
      id: 'msg_prev_u',
      ownerUid: ALICE.uid,
      role: 'user',
      text: 'Remember our secret codeword is APRICOT.',
      createdAt: 1_700_000_000_000,
    });
    await chatStore.appendMessage(
      ALICE.uid,
      'thr_expired_1',
      {
        id: 'msg_prev_a',
        ownerUid: ALICE.uid,
        role: 'assistant',
        text: 'Noted—the codeword is APRICOT.',
        interactionId: 'int_expired_404',
        createdAt: 1_700_000_001_000,
      },
      { lastInteractionId: 'int_expired_404' },
    );

    const attempts: Array<Record<string, unknown>> = [];
    const mockClient: ChatInteractionsClient = {
      async create(params) {
        attempts.push(structuredClone(params));
        if (attempts.length === 1) {
          const notFound = Object.assign(new Error('Interaction int_expired_404 not found'), {
            status: 404,
          });
          throw notFound;
        }
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Your codeword from earlier is APRICOT.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_fresh_200', status: 'completed', steps: [] },
          };
        })();
      },
    };

    const result = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_expired_1',
      text: 'What was our secret codeword?',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.previous_interaction_id).toBe('int_expired_404');
    expect(attempts[1]!.previous_interaction_id).toBeUndefined();
    expect(String(attempts[1]!.input)).toContain('[Previous Thread History]');
    expect(String(attempts[1]!.input)).toContain('APRICOT');

    expect(result.assistantMessage?.text).toBe('Your codeword from earlier is APRICOT.');
    expect(result.thread.lastInteractionId).toBe('int_fresh_200');
  });

  it('cancels cleanly mid-stream when AbortController aborts without corrupting thread state', async () => {
    const controller = new AbortController();
    let yieldedSecondChunk = false;

    const mockClient: ChatInteractionsClient = {
      async create(_params, options) {
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'interaction.created',
            interaction: { id: 'int_aborted_1', status: 'in_progress' },
          };
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Partial response before cancel…' },
          };
          // Abort mid-stream right after the first text delta
          controller.abort();
          if (options?.fetchOptions?.signal?.aborted) {
            return;
          }
          yieldedSecondChunk = true;
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Should never be emitted' },
          };
        })();
      },
    };

    const res = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_abort_1',
      text: 'Write a long essay',
      origin: 'https://studio.example.com',
      signal: controller.signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    expect(res.aborted).toBe(true);
    expect(yieldedSecondChunk).toBe(false);
    expect(res.assistantMessage).toBeNull();
    expect(res.events.some((e) => e.type === 'turn.done')).toBe(false);
    expect(res.events.some((e) => e.type === 'turn.error')).toBe(false);

    // Ensure formatSseEvent + parseSseFrames round-trip cleanly on emitted events
    const serialized = res.events.map(formatSseEvent).join('');
    expect(parseSseFrames(serialized)).toEqual(res.events);
  });

  it('preserves an eagerly-confirmed staged card when confirm fires right on tool.result before turn.done', async () => {
    const tree = await treeStore.createTree(ALICE.uid, { title: 'Eager Confirm Tree' });
    let stepCall = 0;

    const mockClient: ChatInteractionsClient = {
      async create() {
        const idx = stepCall++;
        return (async function* () {
          if (idx === 0) {
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_eager_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_eager_doc_1',
                    name: 'upsert_tree_document',
                    arguments: {
                      treeId: tree.id,
                      path: 'eager.md',
                      markdown: '# Eager Note\n\nSaved immediately.',
                      mode: 'replace',
                    },
                  },
                ],
              },
            };
          } else {
            yield {
              event_type: 'step.delta',
              index: 0,
              delta: { type: 'text', text: 'Staged your document update.' },
            };
            yield {
              event_type: 'interaction.completed',
              interaction: { id: 'int_eager_1', status: 'completed', steps: [] },
            };
          }
        })();
      },
    };

    const res = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_eager_1',
      text: 'Create eager.md',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
      onEvent: async (evt) => {
        if (evt.type === 'tool.result' && evt.callId === 'call_eager_doc_1') {
          // User clicks "Apply edit" while Step 1 is still streaming!
          const confirmed = await confirmStagedChatAction({
            caller: ALICE,
            callId: 'call_eager_doc_1',
            origin: 'https://studio.example.com',
            signal: new AbortController().signal,
            store: chatStore,
          });
          expect(confirmed.card.state).toBe('succeeded');
        }
      },
    });

    expect(res.aborted).toBe(false);
    const card = res.assistantMessage?.resultParts?.find((p) => p.kind === 'action-card');
    expect(card?.kind === 'action-card' && card.state).toBe('succeeded');
  });

  it('forwards model and generation_config.thinking_level when effort is explicit, omits thinking_level on auto, and persists model + effort on assistantMessage', async () => {
    const recordedCalls: Array<Record<string, unknown>> = [];

    const mockClient: ChatInteractionsClient = {
      async create(params) {
        recordedCalls.push(structuredClone(params));
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Synthesized with explicit model and effort.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: `int_eff_${recordedCalls.length}`, status: 'completed', steps: [] },
          };
        })();
      },
    };

    const explicitTurn = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_model_effort_1',
      text: 'Compare the pacing across acts',
      model: 'gemini-4-argon',
      effort: 'high',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    expect(recordedCalls[0]!.model).toBe('gemini-4-argon');
    expect(recordedCalls[0]!.generation_config).toEqual({
      thinking_summaries: 'auto',
      thinking_level: 'high',
      tool_choice: 'auto',
    });
    expect(explicitTurn.assistantMessage?.model).toBe('gemini-4-argon');
    expect(explicitTurn.assistantMessage?.effort).toBe('high');

    const autoTurn = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_model_effort_2',
      text: 'Quick summary',
      model: 'gemini-3.5-flash-lite',
      effort: 'auto',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: mockClient,
    });

    expect(recordedCalls[1]!.model).toBe('gemini-3.5-flash-lite');
    expect(recordedCalls[1]!.generation_config).toEqual({
      thinking_summaries: 'auto',
      tool_choice: 'auto',
    });
    expect(autoTurn.assistantMessage?.model).toBe('gemini-3.5-flash-lite');
    expect(autoTurn.assistantMessage?.effort).toBe('auto');
  });

  it('deduplicates repeated read_media_item embeds across steps and orders media-embed strictly last on persisted assistantMessage', async () => {
    setChatMediaReaderDepsForTests({
      async loadOwnedNarration(_uid, id) {
        return {
          id,
          ownerUid: ALICE.uid,
          authorName: 'Alice',
          authorPhoto: '',
          title: `Narration ${id}`,
          sourceMarkdown: '# Transcript\n\nChunk A. Chunk B.',
          transcript: 'Chunk A. Chunk B.',
          adapted: false,
          voice: 'Sulafat',
          promptStyle: '',
          durationMs: 12_000,
          status: 'ready',
          visibility: 'private',
          audioPath: `narrations/${ALICE.uid}/${id}.wav`,
          timingsPath: `narrations/${ALICE.uid}/${id}.timings.json`,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_002_000,
        };
      },
    });

    try {
      let step = 0;
      const mockClient: ChatInteractionsClient = {
        async create() {
          step += 1;
          if (step === 1) {
            return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
              yield {
                event_type: 'interaction.completed',
                interaction: {
                  id: 'int_dedup_0',
                  status: 'requires_action',
                  steps: [
                    {
                      type: 'function_call',
                      id: 'call_read_page_0',
                      name: 'read_media_item',
                      arguments: { uri: 'mdmedia://narration/nar_ext_1', offset: 0, limit: 8 },
                    },
                    {
                      type: 'function_call',
                      id: 'call_read_page_1',
                      name: 'read_media_item',
                      arguments: { uri: 'mdmedia://narration/nar_ext_1', offset: 8, limit: 8 },
                    },
                    {
                      type: 'function_call',
                      id: 'call_stage_img_1',
                      name: 'generate_image',
                      arguments: { prompt: 'Quiet editorial illustration', aspectRatio: '16:9' },
                    },
                  ],
                },
              };
            })();
          }
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'step.delta',
              index: 0,
              delta: { type: 'text', text: 'Read both slices and staged an image.' },
            };
            yield {
              event_type: 'interaction.completed',
              interaction: { id: 'int_dedup_1', status: 'completed', steps: [] },
            };
          })();
        },
      };

      const res = await runChatTurn({
        caller: ALICE,
        threadId: 'thr_dedup_order_1',
        text: 'Read nar_ext_1 and stage a cover image',
        origin: 'https://studio.example.com',
        signal: new AbortController().signal,
        store: chatStore,
        interactionsClient: mockClient,
      });

      const parts = res.assistantMessage?.resultParts ?? [];
      expect(parts).toHaveLength(2);
      expect(parts[0]?.kind).toBe('action-card');
      expect(parts[1]).toMatchObject({
        kind: 'media-embed',
        mediaType: 'narration',
        itemId: 'nar_ext_1',
      });
    } finally {
      setChatMediaReaderDepsForTests(null);
    }
  });

  it('surfaces out-of-band confirmed thread media into follow-up turns and forwards deliveryMode overrides on confirm', async () => {
    const capturedInputs: Array<{
      previousInteractionId?: string;
      input: unknown;
      systemInstruction?: string;
    }> = [];

    // Turn 1: User runs `/image Intaglio city skyline with a single crimson red building.`
    let turn1Step = 0;
    const turn1Client: ChatInteractionsClient = {
      async create(params) {
        turn1Step += 1;
        capturedInputs.push({
          previousInteractionId: params.previous_interaction_id,
          input: params.input,
          systemInstruction: params.system_instruction,
        });
        if (turn1Step === 1) {
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_img_t1_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_img_v1',
                    name: 'generate_image',
                    arguments: {
                      prompt: 'Intaglio copperplate etching city skyline with one crimson red skyscraper.',
                      title: 'Intaglio Skyline in Crimson',
                      aspectRatio: '16:9',
                    },
                  },
                ],
              },
            };
          })();
        }
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'Click Generate on the card below to start rendering.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_img_t1_1', status: 'completed', steps: [] },
          };
        })();
      },
    };

    await runChatTurn({
      caller: ALICE,
      threadId: 'thr_image_revisions',
      text: '/image Intaglio city skyline with a single crimson red building.',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: turn1Client,
    });

    expect(capturedInputs[0]?.systemInstruction).toContain('rendered below your message');
    expect(capturedInputs[0]?.systemInstruction).toContain('targetItemId');

    // Out-of-band confirmation between Turn 1 and Turn 2 creates `img_skyline_1` + `gen_skyline_v1`
    const firstConfirm = await confirmStagedChatAction({
      caller: ALICE,
      callId: 'call_img_v1',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      treeStore,
      executors: {
        async generate_image() {
          return {
            cardState: 'queued',
            generationId: 'gen_skyline_v1',
            itemId: 'img_skyline_1',
            targetRoute: '/image/img_skyline_1',
            progressMessage: 'Queued image generation…',
            cardActions: [{ kind: 'open-route', label: 'Open image', href: '/image/img_skyline_1' }],
          };
        },
      },
    });
    expect(firstConfirm.card?.itemId).toBe('img_skyline_1');
    expect(firstConfirm.card?.generationId).toBe('gen_skyline_v1');

    const storedAfterTurn1 = await chatStore.listMessages(ALICE.uid, 'thr_image_revisions');
    const mediaBlock = buildRecentThreadMediaPromptBlock(storedAfterTurn1);
    expect(mediaBlock).toContain('[Recent Thread Media Items]');
    expect(mediaBlock).toContain('itemId="img_skyline_1"');
    expect(mediaBlock).toContain('generationId="gen_skyline_v1"');

    // Turn 2: Even with `previous_interaction_id` set, Turn 2 receives `[Recent Thread Media Items]`
    // and stages a revision (`refine`) on `img_skyline_1`!
    let turn2Step = 0;
    const turn2Client: ChatInteractionsClient = {
      async create(params) {
        turn2Step += 1;
        capturedInputs.push({
          previousInteractionId: params.previous_interaction_id,
          input: params.input,
          systemInstruction: params.system_instruction,
        });
        if (turn2Step === 1) {
          return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
            yield {
              event_type: 'interaction.completed',
              interaction: {
                id: 'int_img_t2_0',
                status: 'requires_action',
                steps: [
                  {
                    type: 'function_call',
                    id: 'call_img_v2',
                    name: 'generate_image',
                    arguments: {
                      prompt: 'Make the crimson skyscraper shorter and add sailboats in the river.',
                      targetItemId: 'img_skyline_1',
                      action: 'refine',
                      fromGenerationId: 'gen_skyline_v1',
                    },
                  },
                ],
              },
            };
          })();
        }
        return (async function* (): AsyncGenerator<Interactions.InteractionSSEEvent> {
          yield {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'I staged a revision of Intaglio Skyline in Crimson below.' },
          };
          yield {
            event_type: 'interaction.completed',
            interaction: { id: 'int_img_t2_1', status: 'completed', steps: [] },
          };
        })();
      },
    };

    const turn2 = await runChatTurn({
      caller: ALICE,
      threadId: 'thr_image_revisions',
      text: 'Make the crimson building shorter and add sailboats in the river.',
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      interactionsClient: turn2Client,
    });

    const turn2Step0 = capturedInputs[2];
    expect(turn2Step0?.previousInteractionId).toBe('int_img_t1_1');
    expect(String(turn2Step0?.input)).toContain('[Recent Thread Media Items]');
    expect(String(turn2Step0?.input)).toContain('itemId="img_skyline_1"');
    expect(String(turn2Step0?.input)).toContain('generationId="gen_skyline_v1"');

    expect(turn2.assistantMessage?.resultParts?.[0]).toMatchObject({
      kind: 'action-card',
      callId: 'call_img_v2',
      itemId: 'img_skyline_1',
      revisionTarget: {
        itemId: 'img_skyline_1',
        fromGenerationId: 'gen_skyline_v1',
        defaultMode: 'refine',
      },
    });

    // User switches the staged card's mode selector to `New version` (`regenerate`) and confirms:
    let receivedOverrideMode: string | undefined;
    const secondConfirm = await confirmStagedChatAction({
      caller: ALICE,
      callId: 'call_img_v2',
      overrides: {
        deliveryMode: 'regenerate',
        targetItemId: 'img_skyline_1',
        fromGenerationId: null,
      },
      origin: 'https://studio.example.com',
      signal: new AbortController().signal,
      store: chatStore,
      treeStore,
      executors: {
        async generate_image({ overrides }) {
          receivedOverrideMode = overrides?.deliveryMode;
          return {
            cardState: 'queued',
            generationId: 'gen_skyline_v2',
            itemId: 'img_skyline_1',
            targetRoute: '/image/img_skyline_1',
            cardTitle: 'Intaglio Skyline in Crimson',
            cardMeta: 'New version · 16:9 · gemini-nano-banana-2.1',
            progressMessage: 'Queued new image version…',
            cardActions: [{ kind: 'open-route', label: 'Open image', href: '/image/img_skyline_1' }],
          };
        },
      },
    });
    expect(receivedOverrideMode).toBe('regenerate');
    expect(secondConfirm.card?.title).toBe('Intaglio Skyline in Crimson');
    expect(secondConfirm.card?.meta).toBe('New version · 16:9 · gemini-nano-banana-2.1');
    expect(secondConfirm.card?.generationId).toBe('gen_skyline_v2');
    expect(secondConfirm.card?.itemId).toBe('img_skyline_1');
  });
});
