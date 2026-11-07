/**
 * Server-side confirmation handler for staged Studio Contextual Chat actions.
 *
 * Enforces caller ownership + tool scopes, guarantees idempotency across
 * duplicate clicks or retries (`Idempotency-Key: chat:${callId}`), executes the
 * underlying Studio server mutation, and atomically updates both
 * `chatStagedActions/{callId}` and the persisted message `action-card`.
 */

import { createHash } from 'node:crypto';
import { hasScope, type Caller } from '../api-auth';
import { loadAnalysisItem, prepareAnalysis, submitAnalysis } from '../analysis-server';
import { DEFAULT_IMAGE_MODEL, MediaError, parseImageRequest, readImageDefaults, validMediaId } from '../image-request';
import { imageDefaults, loadImageItem, submitImage } from '../image-server';
import type { ImageRequest, MusicRequest } from '../media-types';
import { parseMusicRequest, readMusicDefaults } from '../music-request';
import { loadMusicItem, musicDefaults, submitMusic } from '../music-server';
import { resolveNarrationBody } from '../narration-api';
import { startNarration } from '../narration-start';
import { readSettings } from '../settings';
import { TreeOpError, type TreeStorePort } from '../tree-types';
import { getServerTreeStore } from '../trees-server';
import { loadUserSettings } from '../user-settings-server';
import { loadVideoItem, submitVideo } from '../video-server';
import {
  ChatStoreError,
  getServerChatStore,
  type ActionCardPart,
  type ChatStorePort,
} from './chat-store-server';
import { getChatTool } from './tools';
import {
  buildTreeDocHref,
  hasConfiguredFirestoreEnv,
  normalizeMediaItemId,
} from './tools/action-tools';
import type {
  ActionCardState,
  CardActionDescriptor,
  ChatMediaType,
  ChatStagedAction,
  ConfirmStagedActionOverrides,
  StagedMediaDeliveryMode,
} from './types';

export class ChatConfirmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatConfirmError';
  }
}

export interface StagedExecutionOutcome {
  cardState: ActionCardState;
  generationId: string | null;
  itemId: string | null;
  targetRoute: string | null;
  cardTitle?: string | null;
  cardMeta?: string | null;
  progressMessage?: string | null;
  cardActions: CardActionDescriptor[];
}

export type StagedToolExecutor = (params: {
  caller: Caller;
  callId: string;
  idempotencyKey: string;
  validatedInput: Record<string, unknown>;
  overrides?: ConfirmStagedActionOverrides;
  origin: string;
  signal: AbortSignal;
  treeStore: TreeStorePort;
}) => Promise<StagedExecutionOutcome>;

export interface ConfirmStagedChatActionParams {
  caller: Caller;
  callId: string;
  overrides?: ConfirmStagedActionOverrides;
  origin: string;
  signal: AbortSignal;
  store?: ChatStorePort;
  treeStore?: TreeStorePort;
  executors?: Partial<Record<string, StagedToolExecutor>>;
}

export interface ConfirmStagedChatActionResult {
  action: ChatStagedAction;
  card: ActionCardPart | null;
  replayed: boolean;
}

function deterministicNarrationId(callId: string): string {
  const hex = createHash('sha256').update(`chat:${callId}`).digest('hex').slice(0, 24);
  return `chat_narr_${hex}`;
}

const VALID_DELIVERY_MODES: readonly StagedMediaDeliveryMode[] = ['refine', 'regenerate', 'new_item'];

function resolveDeliveryChoice(
  validatedInput: Record<string, unknown>,
  overrides: ConfirmStagedActionOverrides | undefined,
  expectedType: ChatMediaType,
): {
  mode: StagedMediaDeliveryMode;
  targetItemId: string | null;
  fromGenerationId: string | null;
} {
  if (overrides?.deliveryMode !== undefined && !VALID_DELIVERY_MODES.includes(overrides.deliveryMode)) {
    throw new ChatConfirmError(400, 'invalid_delivery_mode', 'Invalid deliveryMode override.');
  }

  const stagedModeRaw = validatedInput.deliveryMode;
  const stagedMode: StagedMediaDeliveryMode = VALID_DELIVERY_MODES.includes(
    stagedModeRaw as StagedMediaDeliveryMode,
  )
    ? (stagedModeRaw as StagedMediaDeliveryMode)
    : typeof validatedInput.targetItemId === 'string' && validatedInput.targetItemId.trim()
      ? 'regenerate'
      : 'new_item';

  const mode: StagedMediaDeliveryMode = overrides?.deliveryMode ?? stagedMode;
  if (mode === 'new_item') {
    return { mode: 'new_item', targetItemId: null, fromGenerationId: null };
  }

  const rawTarget =
    overrides?.targetItemId !== undefined
      ? overrides.targetItemId
      : typeof validatedInput.targetItemId === 'string'
        ? validatedInput.targetItemId
        : null;
  const cleanTargetId = normalizeMediaItemId(rawTarget, expectedType);
  if (!cleanTargetId || !validMediaId(cleanTargetId)) {
    throw new ChatConfirmError(
      400,
      'invalid_target_item',
      `Choose a valid existing ${expectedType} item to update.`,
    );
  }

  const rawFromGen =
    overrides?.fromGenerationId !== undefined
      ? overrides.fromGenerationId
      : typeof validatedInput.fromGenerationId === 'string'
        ? validatedInput.fromGenerationId
        : null;
  const cleanFromGen = rawFromGen?.trim() || null;
  if (cleanFromGen && !validMediaId(cleanFromGen)) {
    throw new ChatConfirmError(400, 'invalid_generation', 'Invalid fromGenerationId.');
  }

  return {
    mode,
    targetItemId: cleanTargetId,
    fromGenerationId: cleanFromGen,
  };
}

const DEFAULT_EXECUTORS: Record<string, StagedToolExecutor> = {
  async analyze_video({ caller, idempotencyKey, validatedInput, overrides }) {
    const analysisBody = (validatedInput.analysisBody ?? {}) as Record<string, unknown>;
    const { targetItemId } = resolveDeliveryChoice(validatedInput, overrides, 'analysis');
    let existingAnalysis: Awaited<ReturnType<typeof loadAnalysisItem>> | null = null;
    if (targetItemId) {
      if (!hasScope(caller, 'analyses:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot analyses read.');
      }
      existingAnalysis = await loadAnalysisItem(caller.uid, targetItemId);
    }
    const prepared = await prepareAnalysis(caller, analysisBody, existingAnalysis);
    const accepted = await submitAnalysis(
      caller.uid,
      prepared,
      analysisBody,
      idempotencyKey,
      targetItemId,
    );
    const href = `/analysis/${encodeURIComponent(accepted.itemId)}`;
    return {
      cardState: 'queued',
      generationId: accepted.generationId,
      itemId: accepted.itemId,
      targetRoute: href,
      ...(existingAnalysis ? { cardTitle: existingAnalysis.title } : {}),
      progressMessage: targetItemId ? 'Queued new analysis version…' : 'Queued video analysis…',
      cardActions: [{ kind: 'open-route', label: 'Open analysis', href }],
    };
  },

  async create_narration({ caller, callId, validatedInput }) {
    const narrationBody = {
      ...((validatedInput.narrationBody ?? {}) as Record<string, unknown>),
      id: deterministicNarrationId(callId),
    };
    const settings = hasConfiguredFirestoreEnv()
      ? await loadUserSettings(caller.uid).catch(() => readSettings(undefined))
      : readSettings(undefined);
    const resolved = resolveNarrationBody(narrationBody, settings, {
      restricted: caller.kind === 'apiKey',
    });
    if (!resolved.ok) {
      throw new ChatConfirmError(resolved.status, resolved.code, resolved.message);
    }

    const detached = new AbortController();
    const started = await startNarration({
      uid: caller.uid,
      request: resolved.request,
      signal: detached.signal,
    });
    if (!started.ok) {
      throw new ChatConfirmError(started.status, started.code, started.message);
    }
    detached.abort();
    void started.stream.cancel().catch(() => {});

    const href = `/narration/${encodeURIComponent(started.id)}`;
    return {
      cardState: 'running',
      generationId: started.id,
      itemId: started.id,
      targetRoute: href,
      progressMessage: 'Synthesizing narration…',
      cardActions: [{ kind: 'open-route', label: 'Open narration', href }],
    };
  },

  async generate_image({ caller, idempotencyKey, validatedInput, overrides }) {
    const rawImageBody = {
      ...((validatedInput.imageBody ?? {}) as Record<string, unknown>),
    };
    delete rawImageBody.action;
    delete rawImageBody.fromGenerationId;

    // Resolve any deferred referenceImageItemIds if present
    if (Array.isArray(validatedInput.referenceImageItemIds) && validatedInput.referenceImageItemIds.length > 0) {
      if (!hasScope(caller, 'images:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot images read.');
      }
      const existingRefIds = Array.isArray(rawImageBody.referenceAssetIds)
        ? [...(rawImageBody.referenceAssetIds as string[])]
        : [];
      for (const rawRefItem of validatedInput.referenceImageItemIds) {
        if (typeof rawRefItem !== 'string') continue;
        const refImg = await loadImageItem(caller.uid, rawRefItem);
        if (!refImg.thumbnailAssetId) {
          throw new ChatConfirmError(409, 'image_not_ready', 'Reference image has no finished frame yet.');
        }
        if (!existingRefIds.includes(refImg.thumbnailAssetId)) {
          existingRefIds.push(refImg.thumbnailAssetId);
        }
      }
      if (existingRefIds.length > 0) {
        rawImageBody.referenceAssetIds = existingRefIds;
      }
    }

    const { mode, targetItemId, fromGenerationId } = resolveDeliveryChoice(
      validatedInput,
      overrides,
      'image',
    );
    const apiKeyId = caller.kind === 'apiKey' ? caller.keyId : null;

    if (targetItemId) {
      if (!hasScope(caller, 'images:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot images read.');
      }
      const existingItem = await loadImageItem(caller.uid, targetItemId);
      const parentGenId =
        mode === 'refine'
          ? fromGenerationId || existingItem.latestSuccessfulGenerationId || null
          : null;
      const effectiveImageAction: 'refine' | 'regenerate' =
        mode === 'refine' && parentGenId ? 'refine' : 'regenerate';

      const nextImageBody: Record<string, unknown> = {
        ...rawImageBody,
        action: effectiveImageAction,
        ...(effectiveImageAction === 'refine' && parentGenId
          ? { fromGenerationId: parentGenId }
          : {}),
      };
      const baseDefaults = {
        ...existingItem.request,
        referenceAssetId: null,
        referenceAssetIds: [],
      };
      const request = parseImageRequest(nextImageBody, baseDefaults);
      const accepted = await submitImage(
        caller.uid,
        request,
        idempotencyKey,
        targetItemId,
        apiKeyId,
        nextImageBody,
      );
      const href = `/image/${encodeURIComponent(accepted.itemId)}`;
      const effectiveModel = request.model ?? DEFAULT_IMAGE_MODEL;
      const badge = effectiveImageAction === 'refine' ? 'Revision' : 'New version';
      return {
        cardState: 'queued',
        generationId: accepted.generationId,
        itemId: accepted.itemId,
        targetRoute: href,
        cardTitle: existingItem.title,
        cardMeta: `${badge} · ${request.output.aspectRatio} · ${effectiveModel}`,
        progressMessage:
          effectiveImageAction === 'refine'
            ? 'Queued image revision…'
            : 'Queued new image version…',
        cardActions: [{ kind: 'open-route', label: 'Open image', href }],
      };
    }

    const defaults = hasConfiguredFirestoreEnv()
      ? await imageDefaults(caller.uid).catch(() => readImageDefaults(undefined))
      : readImageDefaults(undefined);
    const request: ImageRequest = parseImageRequest(rawImageBody, defaults);
    const accepted = await submitImage(
      caller.uid,
      request,
      idempotencyKey,
      null,
      apiKeyId,
      rawImageBody,
    );
    const href = `/image/${encodeURIComponent(accepted.itemId)}`;
    const effectiveModel = request.model ?? DEFAULT_IMAGE_MODEL;
    return {
      cardState: 'queued',
      generationId: accepted.generationId,
      itemId: accepted.itemId,
      targetRoute: href,
      cardMeta: `${request.output.aspectRatio} · ${effectiveModel}`,
      progressMessage: 'Queued image generation…',
      cardActions: [{ kind: 'open-route', label: 'Open image', href }],
    };
  },

  async generate_video({ caller, idempotencyKey, validatedInput, overrides }) {
    const rawSettingsBody: Record<string, unknown> = {
      ...((validatedInput.videoBody ?? {}) as Record<string, unknown>),
    };
    delete rawSettingsBody.action;
    delete rawSettingsBody.fromGenerationId;

    if (typeof validatedInput.startImageItemId === 'string' && !rawSettingsBody.referenceAssetId) {
      if (!hasScope(caller, 'images:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot images read.');
      }
      const imgItem = await loadImageItem(caller.uid, validatedInput.startImageItemId);
      if (!imgItem.thumbnailAssetId) {
        throw new ChatConfirmError(409, 'image_not_ready', 'That image has no finished frame to animate yet.');
      }
      rawSettingsBody.referenceAssetId = imgItem.thumbnailAssetId;
      rawSettingsBody.referenceRole = 'first_frame';
    }

    const { mode, targetItemId } = resolveDeliveryChoice(validatedInput, overrides, 'video');
    if (targetItemId) {
      if (!hasScope(caller, 'videos:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot videos read.');
      }
      const existingVideo = await loadVideoItem(caller.uid, targetItemId);
      const currentGenId =
        existingVideo.latestSuccessfulGenerationId ?? existingVideo.latestGenerationId;
      const videoAction: 'continue' | 'regenerate_latest' =
        mode === 'refine' && existingVideo.latestSuccessfulGenerationId
          ? 'continue'
          : 'regenerate_latest';

      if (existingVideo.latestSuccessfulGenerationId) {
        const currentOutput =
          rawSettingsBody.output && typeof rawSettingsBody.output === 'object'
            ? (rawSettingsBody.output as Record<string, unknown>)
            : {};
        rawSettingsBody.output = {
          ...currentOutput,
          aspectRatio: existingVideo.request.output.aspectRatio,
          resolution: existingVideo.request.output.resolution,
        };
      }
      if (videoAction === 'continue' && rawSettingsBody.referenceAssetId) {
        rawSettingsBody.referenceRole = 'reference';
      }

      const actionBody: Record<string, unknown> = {
        ...rawSettingsBody,
        action: videoAction,
        fromGenerationId: currentGenId,
      };
      const accepted = await submitVideo(caller.uid, actionBody, idempotencyKey, targetItemId);
      const href = `/video/${encodeURIComponent(accepted.itemId)}`;
      return {
        cardState: 'queued',
        generationId: accepted.generationId,
        itemId: accepted.itemId,
        targetRoute: href,
        cardTitle: existingVideo.title,
        progressMessage:
          videoAction === 'continue'
            ? 'Queued video continuation…'
            : 'Queued new video version…',
        cardActions: [{ kind: 'open-route', label: 'Open video', href }],
      };
    }

    const accepted = await submitVideo(caller.uid, rawSettingsBody, idempotencyKey, null);
    const href = `/video/${encodeURIComponent(accepted.itemId)}`;
    return {
      cardState: 'queued',
      generationId: accepted.generationId,
      itemId: accepted.itemId,
      targetRoute: href,
      progressMessage: 'Queued video generation…',
      cardActions: [{ kind: 'open-route', label: 'Open video', href }],
    };
  },

  async generate_music({ caller, idempotencyKey, validatedInput, overrides }) {
    const musicBody = (validatedInput.musicBody ?? {}) as Record<string, unknown>;
    const { targetItemId } = resolveDeliveryChoice(validatedInput, overrides, 'music');
    const apiKeyId = caller.kind === 'apiKey' ? caller.keyId : null;

    if (targetItemId) {
      if (!hasScope(caller, 'music:read')) {
        throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot music read.');
      }
      const existingMusic = await loadMusicItem(caller.uid, targetItemId);
      const request = parseMusicRequest(musicBody, {
        ...existingMusic.request,
        referenceAssetId: null,
      });
      const accepted = await submitMusic(
        caller.uid,
        request,
        idempotencyKey,
        targetItemId,
        apiKeyId,
        musicBody,
      );
      const href = `/music/${encodeURIComponent(accepted.itemId)}`;
      const modeLabel = request.output.mode === 'clip' ? '30s clip' : 'Full song';
      return {
        cardState: 'queued',
        generationId: accepted.generationId,
        itemId: accepted.itemId,
        targetRoute: href,
        cardTitle: existingMusic.title,
        cardMeta: `New version · ${modeLabel} · ${request.vocals}`,
        progressMessage: 'Queued new music version…',
        cardActions: [{ kind: 'open-route', label: 'Open music', href }],
      };
    }

    const defaults = hasConfiguredFirestoreEnv()
      ? await musicDefaults(caller.uid).catch(() => readMusicDefaults(undefined))
      : readMusicDefaults(undefined);
    const request: MusicRequest = validatedInput.request
      ? (validatedInput.request as unknown as MusicRequest)
      : parseMusicRequest(musicBody, defaults);
    const accepted = await submitMusic(caller.uid, request, idempotencyKey, null, apiKeyId, musicBody);
    const href = `/music/${encodeURIComponent(accepted.itemId)}`;
    const modeLabel = request.output.mode === 'clip' ? '30s clip' : 'Full song';
    return {
      cardState: 'queued',
      generationId: accepted.generationId,
      itemId: accepted.itemId,
      targetRoute: href,
      cardMeta: `${modeLabel} · ${request.vocals}`,
      progressMessage: 'Queued music generation…',
      cardActions: [{ kind: 'open-route', label: 'Open music', href }],
    };
  },

  async insert_media_into_document({ caller, idempotencyKey, validatedInput, treeStore }) {
    const treeId = String(validatedInput.treeId ?? '');
    const path = String(validatedInput.path ?? '');
    const nextMarkdown = String(validatedInput.nextMarkdown ?? '');
    const nodeId = typeof validatedInput.nodeId === 'string' ? validatedInput.nodeId : undefined;
    const title = typeof validatedInput.title === 'string' ? validatedInput.title : undefined;
    const expectedUpdatedAt =
      typeof validatedInput.expectedUpdatedAt === 'number' ? validatedInput.expectedUpdatedAt : null;

    if (!treeId || !path) {
      throw new ChatConfirmError(400, 'invalid_staged_input', 'Missing target tree or document path.');
    }

    const currentDoc = await treeStore.getDocument(caller.uid, treeId, path);
    if (expectedUpdatedAt !== null && currentDoc.updatedAt !== expectedUpdatedAt) {
      throw new ChatConfirmError(
        409,
        'document_conflict',
        `Document "${currentDoc.path}" changed since this insertion was staged. Ask Chat to stage it again against the latest version.`,
      );
    }

    await treeStore.applyOps(
      caller.uid,
      treeId,
      [
        {
          op: 'put_doc',
          path: currentDoc.path,
          ...(nodeId ? { nodeId } : {}),
          ...(title ? { title } : {}),
          markdown: nextMarkdown,
        },
      ],
      { idempotencyKey },
    );

    const href = buildTreeDocHref(treeId, currentDoc.path);
    return {
      cardState: 'succeeded',
      generationId: null,
      itemId: currentDoc.id,
      targetRoute: href,
      progressMessage: null,
      cardActions: [{ kind: 'open-route', label: 'Open doc', href }],
    };
  },

  async upsert_tree_document({ caller, idempotencyKey, validatedInput, treeStore }) {
    const requestedTreeId = typeof validatedInput.treeId === 'string' ? validatedInput.treeId : '';
    const createTreeTitle =
      typeof validatedInput.createTreeTitle === 'string' ? validatedInput.createTreeTitle : '';
    const path = String(validatedInput.path ?? '');
    const nextMarkdown = String(validatedInput.nextMarkdown ?? validatedInput.markdown ?? '');
    const nodeId = typeof validatedInput.nodeId === 'string' ? validatedInput.nodeId : undefined;
    const title = typeof validatedInput.title === 'string' ? validatedInput.title : undefined;
    const hasExpected = 'expectedUpdatedAt' in validatedInput;
    const expectedUpdatedAt = validatedInput.expectedUpdatedAt as number | null | undefined;

    if (!path) {
      throw new ChatConfirmError(400, 'invalid_staged_input', 'Missing target document path.');
    }

    let finalTreeId = requestedTreeId;
    if (!finalTreeId) {
      const created = await treeStore.createTree(caller.uid, {
        title: createTreeTitle || 'Workspace Notes',
        ops: [
          {
            op: 'put_doc',
            path,
            ...(title ? { title } : {}),
            markdown: nextMarkdown,
          },
        ],
        idempotencyKey,
      });
      finalTreeId = created.id;
    } else {
      const currentDoc = await treeStore.getDocument(caller.uid, finalTreeId, path).catch(() => null);
      if (hasExpected) {
        if (expectedUpdatedAt === null && currentDoc !== null) {
          throw new ChatConfirmError(
            409,
            'document_conflict',
            `Document "${path}" was created after this edit was staged.`,
          );
        }
        if (typeof expectedUpdatedAt === 'number' && (!currentDoc || currentDoc.updatedAt !== expectedUpdatedAt)) {
          throw new ChatConfirmError(
            409,
            'document_conflict',
            `Document "${path}" changed since this edit was staged. Ask Chat to stage it again against the latest version.`,
          );
        }
      }

      await treeStore.applyOps(
        caller.uid,
        finalTreeId,
        [
          {
            op: 'put_doc',
            path,
            ...(nodeId ? { nodeId } : {}),
            ...(title ? { title } : {}),
            markdown: nextMarkdown,
          },
        ],
        { idempotencyKey },
      );
    }

    const href = buildTreeDocHref(finalTreeId, path);
    return {
      cardState: 'succeeded',
      generationId: null,
      itemId: null,
      targetRoute: href,
      progressMessage: null,
      cardActions: [{ kind: 'open-route', label: 'Open doc', href }],
    };
  },
};

const inFlightConfirmations = new Map<string, Promise<ConfirmStagedChatActionResult>>();

export async function confirmStagedChatAction(
  params: ConfirmStagedChatActionParams,
): Promise<ConfirmStagedChatActionResult> {
  const { caller, callId, origin, signal } = params;
  const chatStore = params.store ?? getServerChatStore();
  const treeStore = params.treeStore ?? getServerTreeStore();

  if (!hasScope(caller, 'chat:use')) {
    throw new ChatConfirmError(403, 'insufficient_scope', 'This API key cannot chat use.');
  }

  const lockKey = `${caller.uid}:${callId}`;
  const existingInFlight = inFlightConfirmations.get(lockKey);
  if (existingInFlight) {
    const res = await existingInFlight;
    return { ...res, replayed: true };
  }

  const task = (async (): Promise<ConfirmStagedChatActionResult> => {
    let staged: ChatStagedAction | null;
    try {
      staged = await chatStore.getStagedAction(caller.uid, callId);
    } catch (err) {
      if (err instanceof ChatStoreError) {
        throw new ChatConfirmError(err.status, err.code, err.message);
      }
      throw err;
    }

    if (!staged || staged.ownerUid !== caller.uid) {
      throw new ChatConfirmError(404, 'not_found', 'That staged action is not available to you.');
    }

    const tool = getChatTool(staged.toolName);
    if (!tool) {
      throw new ChatConfirmError(400, 'unsupported_tool', `Tool "${staged.toolName}" cannot be confirmed.`);
    }

    for (const scope of tool.requiredScopes) {
      if (!hasScope(caller, scope)) {
        throw new ChatConfirmError(
          403,
          'insufficient_scope',
          `This API key cannot ${scope.replace(':', ' ')}.`,
        );
      }
    }

    if (staged.state === 'submitted') {
      const existingCard = await chatStore.getMessageActionCard(
        caller.uid,
        staged.threadId,
        staged.messageId,
        staged.callId,
      );
      return {
        action: staged,
        card: existingCard,
        replayed: true,
      };
    }

    if (staged.state === 'canceled') {
      throw new ChatConfirmError(409, 'action_canceled', 'That staged action was canceled.');
    }

    const executor = params.executors?.[staged.toolName] ?? DEFAULT_EXECUTORS[staged.toolName];
    if (!executor) {
      throw new ChatConfirmError(
        400,
        'unsupported_tool',
        `Tool "${staged.toolName}" does not support staged confirmation.`,
      );
    }

    const idempotencyKey = `chat:${staged.callId}`;
    let outcome: StagedExecutionOutcome;
    try {
      outcome = await executor({
        caller,
        callId: staged.callId,
        idempotencyKey,
        validatedInput: staged.validatedInput,
        overrides: params.overrides,
        origin,
        signal,
        treeStore,
      });
    } catch (error) {
      if (error instanceof ChatConfirmError) throw error;
      if (error instanceof MediaError) {
        throw new ChatConfirmError(error.status, error.code, error.message);
      }
      if (error instanceof TreeOpError) {
        throw new ChatConfirmError(error.status, error.code, error.message);
      }
      throw error;
    }

    const now = Date.now();
    const updated = await chatStore.updateMessageActionCard(
      caller.uid,
      staged.threadId,
      staged.messageId,
      staged.callId,
      (currentCard) => ({
        card: {
          ...currentCard,
          ...(outcome.cardTitle ? { title: outcome.cardTitle } : {}),
          ...(outcome.cardMeta ? { meta: outcome.cardMeta } : {}),
          state: outcome.cardState,
          generationId: outcome.generationId,
          itemId: outcome.itemId,
          targetRoute: outcome.targetRoute ?? currentCard.targetRoute ?? null,
          progressMessage: outcome.progressMessage ?? null,
          errorMessage: null,
          cardActions: outcome.cardActions,
        },
        actionPatch: {
          state: 'submitted',
          generationId: outcome.generationId,
          resultItemId: outcome.itemId,
          targetRoute: outcome.targetRoute,
          updatedAt: now,
        },
      }),
    );

    let finalAction = updated.action;
    if (!finalAction || finalAction.state !== 'submitted') {
      finalAction = await chatStore.putStagedAction(caller.uid, {
        ...staged,
        state: 'submitted',
        generationId: outcome.generationId,
        resultItemId: outcome.itemId,
        targetRoute: outcome.targetRoute,
        updatedAt: now,
      });
    }

    return {
      action: finalAction,
      card: updated.card,
      replayed: false,
    };
  })();

  inFlightConfirmations.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlightConfirmations.delete(lockKey);
  }
}
