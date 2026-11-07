/**
 * Server persistence port for Studio Contextual Chat threads, messages, and staged actions.
 *
 * Collections:
 * - `chatThreads/{threadId}`
 * - `chatThreads/{threadId}/messages/{messageId}`
 * - `chatStagedActions/{callId}`
 *
 * All reads, updates, and deletes enforce `ownerUid === uid`.
 */

import { randomUUID } from 'node:crypto';
import { adminDb } from '../firebase-admin';
import { validMediaId } from '../image-request';
import type {
  ChatResultPart,
  ChatStagedAction,
  ChatThreadSummary,
  StoredChatMessage,
} from './types';

export type ActionCardPart = Extract<ChatResultPart, { kind: 'action-card' }>;

export type StagedActionPatch = Partial<
  Pick<ChatStagedAction, 'state' | 'generationId' | 'resultItemId' | 'targetRoute' | 'updatedAt'>
>;

export class ChatStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatStoreError';
  }
}

export function deriveThreadTitle(text: string, fallback = 'New chat'): string {
  const cleaned = text
    .trim()
    .replace(/^\/[a-zA-Z-]+\s*/, '')
    .split('\n')[0]
    ?.replace(/[*_`~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 48 ? `${cleaned.slice(0, 47).trimEnd()}…` : cleaned;
}

function assertValidDocId(id: string, label: string): string {
  const trimmed = id.trim();
  if (!validMediaId(trimmed)) {
    throw new ChatStoreError(400, `invalid_${label}`, `Invalid ${label}.`);
  }
  return trimmed;
}

function mergePreservedActionCards(
  existing: StoredChatMessage | undefined,
  incoming: StoredChatMessage,
): StoredChatMessage {
  if (!existing?.resultParts?.length || !incoming.resultParts?.length) {
    return incoming;
  }
  const upgradedByCallId = new Map<string, ActionCardPart>();
  for (const part of existing.resultParts) {
    if (part.kind === 'action-card' && part.state !== 'staged') {
      upgradedByCallId.set(part.callId, part);
    }
  }
  if (upgradedByCallId.size === 0) return incoming;
  return {
    ...incoming,
    resultParts: incoming.resultParts.map((part) => {
      if (part.kind === 'action-card' && part.state === 'staged') {
        return upgradedByCallId.get(part.callId) ?? part;
      }
      return part;
    }),
  };
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    }
    return out as T;
  }
  return value;
}

export interface ChatStorePort {
  listThreads(uid: string, limit?: number): Promise<ChatThreadSummary[]>;
  getThread(uid: string, threadId: string): Promise<ChatThreadSummary | null>;
  createThread(
    uid: string,
    input?: { id?: string; title?: string; lastSurface?: string | null },
  ): Promise<ChatThreadSummary>;
  ensureThread(
    uid: string,
    input: { id: string; title?: string; lastSurface?: string | null },
  ): Promise<ChatThreadSummary>;
  updateThread(
    uid: string,
    threadId: string,
    patch: {
      title?: string;
      lastInteractionId?: string | null;
      lastSurface?: string | null;
      updatedAt?: number;
    },
  ): Promise<ChatThreadSummary>;
  deleteThread(uid: string, threadId: string): Promise<void>;
  listMessages(uid: string, threadId: string, limit?: number): Promise<StoredChatMessage[]>;
  appendMessage(
    uid: string,
    threadId: string,
    message: StoredChatMessage,
    threadPatch?: {
      title?: string;
      lastInteractionId?: string | null;
      lastSurface?: string | null;
    },
  ): Promise<{ message: StoredChatMessage; thread: ChatThreadSummary }>;
  putStagedAction(uid: string, action: ChatStagedAction): Promise<ChatStagedAction>;
  getStagedAction(uid: string, callId: string): Promise<ChatStagedAction | null>;
  getMessageActionCard(
    uid: string,
    threadId: string,
    messageId: string,
    callId: string,
  ): Promise<ActionCardPart | null>;
  updateMessageActionCard(
    uid: string,
    threadId: string,
    messageId: string,
    callId: string,
    updater: (
      card: ActionCardPart,
      action: ChatStagedAction | null,
    ) => { card: ActionCardPart; actionPatch?: StagedActionPatch },
  ): Promise<{ action: ChatStagedAction | null; card: ActionCardPart | null }>;
}

// ============================================================================
// In-Memory Store (for fast hermetic unit tests)
// ============================================================================

export function createInMemoryChatStore(): ChatStorePort {
  const threads = new Map<string, ChatThreadSummary>();
  const messagesByThread = new Map<string, StoredChatMessage[]>();
  const stagedActions = new Map<string, ChatStagedAction>();

  const requireOwnedThread = (uid: string, rawId: string): ChatThreadSummary => {
    const id = assertValidDocId(rawId, 'thread_id');
    const existing = threads.get(id);
    if (!existing || existing.ownerUid !== uid) {
      throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
    }
    return existing;
  };

  return {
    async listThreads(uid, limit = 30) {
      const cap = Math.min(Math.max(Math.floor(limit), 1), 30);
      return [...threads.values()]
        .filter((t) => t.ownerUid === uid)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
        .slice(0, cap)
        .map((t) => structuredClone(t));
    },

    async getThread(uid, threadId) {
      const id = assertValidDocId(threadId, 'thread_id');
      const existing = threads.get(id);
      if (!existing) return null;
      if (existing.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
      }
      return structuredClone(existing);
    },

    async createThread(uid, input) {
      const id = input?.id ? assertValidDocId(input.id, 'thread_id') : `thr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const existing = threads.get(id);
      if (existing) {
        if (existing.ownerUid !== uid) {
          throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
        }
        return structuredClone(existing);
      }
      const now = Date.now();
      const summary: ChatThreadSummary = {
        id,
        ownerUid: uid,
        title: input?.title?.trim() ? input.title.trim().slice(0, 120) : 'New chat',
        lastInteractionId: null,
        lastSurface: input?.lastSurface ?? null,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      threads.set(id, summary);
      messagesByThread.set(id, []);
      return structuredClone(summary);
    },

    async ensureThread(uid, input) {
      const id = assertValidDocId(input.id, 'thread_id');
      const existing = threads.get(id);
      if (existing) {
        if (existing.ownerUid !== uid) {
          throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
        }
        return structuredClone(existing);
      }
      return this.createThread(uid, input);
    },

    async updateThread(uid, threadId, patch) {
      const existing = requireOwnedThread(uid, threadId);
      const updated: ChatThreadSummary = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) || existing.title } : {}),
        ...(patch.lastInteractionId !== undefined ? { lastInteractionId: patch.lastInteractionId } : {}),
        ...(patch.lastSurface !== undefined ? { lastSurface: patch.lastSurface } : {}),
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      threads.set(existing.id, updated);
      return structuredClone(updated);
    },

    async deleteThread(uid, threadId) {
      const existing = requireOwnedThread(uid, threadId);
      threads.delete(existing.id);
      messagesByThread.delete(existing.id);
      for (const [callId, staged] of stagedActions.entries()) {
        if (staged.threadId === existing.id && staged.ownerUid === uid) {
          stagedActions.delete(callId);
        }
      }
    },

    async listMessages(uid, threadId, limit = 200) {
      const existing = requireOwnedThread(uid, threadId);
      const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
      const list = messagesByThread.get(existing.id) ?? [];
      return list
        .filter((m) => m.ownerUid === uid)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-cap)
        .map((m) => structuredClone(m));
    },

    async appendMessage(uid, threadId, message, threadPatch) {
      const existing = requireOwnedThread(uid, threadId);
      if (message.ownerUid !== uid) {
        throw new ChatStoreError(403, 'forbidden', 'Message owner mismatch.');
      }
      const list = messagesByThread.get(existing.id) ?? [];
      const existingIdx = list.findIndex((m) => m.id === message.id);
      const stored = structuredClone(
        mergePreservedActionCards(existingIdx >= 0 ? list[existingIdx] : undefined, message),
      );
      if (existingIdx >= 0) {
        list[existingIdx] = stored;
      } else {
        list.push(stored);
      }
      messagesByThread.set(existing.id, list);

      const now = Math.max(Date.now(), stored.createdAt);
      const nextThread: ChatThreadSummary = {
        ...existing,
        ...(threadPatch?.title ? { title: threadPatch.title.trim().slice(0, 120) } : {}),
        ...(threadPatch?.lastInteractionId !== undefined
          ? { lastInteractionId: threadPatch.lastInteractionId }
          : {}),
        ...(threadPatch?.lastSurface !== undefined ? { lastSurface: threadPatch.lastSurface } : {}),
        messageCount: list.length,
        updatedAt: now,
      };
      threads.set(existing.id, nextThread);
      return {
        message: structuredClone(stored),
        thread: structuredClone(nextThread),
      };
    },

    async putStagedAction(uid, action) {
      if (action.ownerUid !== uid) {
        throw new ChatStoreError(403, 'forbidden', 'Staged action owner mismatch.');
      }
      const callId = assertValidDocId(action.callId, 'call_id');
      const existing = stagedActions.get(callId);
      if (existing && existing.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
      }
      const stored = structuredClone({ ...action, callId });
      stagedActions.set(callId, stored);
      return structuredClone(stored);
    },

    async getStagedAction(uid, callId) {
      const id = assertValidDocId(callId, 'call_id');
      const existing = stagedActions.get(id);
      if (!existing) return null;
      if (existing.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
      }
      return structuredClone(existing);
    },

    async getMessageActionCard(uid, threadId, messageId, callId) {
      const existing = requireOwnedThread(uid, threadId);
      const list = messagesByThread.get(existing.id) ?? [];
      const msg = list.find((m) => m.id === messageId && m.ownerUid === uid);
      if (!msg?.resultParts) return null;
      const found = msg.resultParts.find(
        (part): part is ActionCardPart => part.kind === 'action-card' && part.callId === callId,
      );
      return found ? structuredClone(found) : null;
    },

    async updateMessageActionCard(uid, threadId, messageId, callId, updater) {
      const existing = requireOwnedThread(uid, threadId);
      const id = assertValidDocId(callId, 'call_id');
      const staged = stagedActions.get(id) ?? null;
      if (staged && staged.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
      }

      const list = messagesByThread.get(existing.id) ?? [];
      const msgIdx = list.findIndex((m) => m.id === messageId && m.ownerUid === uid);
      if (msgIdx < 0) {
        return { action: staged ? structuredClone(staged) : null, card: null };
      }

      const msg = structuredClone(list[msgIdx]!);
      const parts = [...(msg.resultParts ?? [])];
      const cardIdx = parts.findIndex(
        (part): part is ActionCardPart => part.kind === 'action-card' && part.callId === id,
      );
      if (cardIdx < 0) {
        return { action: staged ? structuredClone(staged) : null, card: null };
      }

      const currentCard = parts[cardIdx] as ActionCardPart;
      const { card: updatedCard, actionPatch } = updater(
        structuredClone(currentCard),
        staged ? structuredClone(staged) : null,
      );
      parts[cardIdx] = updatedCard;
      msg.resultParts = parts;
      list[msgIdx] = msg;
      messagesByThread.set(existing.id, list);

      let nextAction: ChatStagedAction | null = staged ? structuredClone(staged) : null;
      if (nextAction && actionPatch) {
        nextAction = {
          ...nextAction,
          ...actionPatch,
          updatedAt: actionPatch.updatedAt ?? Date.now(),
        };
        stagedActions.set(id, nextAction);
      }

      return {
        action: nextAction ? structuredClone(nextAction) : null,
        card: structuredClone(updatedCard),
      };
    },
  };
}

// ============================================================================
// Firestore Store (Production)
// ============================================================================

class FirestoreChatStore implements ChatStorePort {
  private threadRef(threadId: string) {
    return adminDb().collection('chatThreads').doc(threadId);
  }

  private messagesCol(threadId: string) {
    return this.threadRef(threadId).collection('messages');
  }

  private stagedRef(callId: string) {
    return adminDb().collection('chatStagedActions').doc(callId);
  }

  async listThreads(uid: string, limit = 30): Promise<ChatThreadSummary[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 30);
    const snap = await adminDb()
      .collection('chatThreads')
      .where('ownerUid', '==', uid)
      .orderBy('updatedAt', 'desc')
      .limit(cap)
      .get();
    return snap.docs.map((doc) => doc.data() as ChatThreadSummary);
  }

  async getThread(uid: string, threadId: string): Promise<ChatThreadSummary | null> {
    const id = assertValidDocId(threadId, 'thread_id');
    const snap = await this.threadRef(id).get();
    if (!snap.exists) return null;
    const data = snap.data() as ChatThreadSummary | undefined;
    if (!data || data.ownerUid !== uid) {
      throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
    }
    return data;
  }

  async createThread(
    uid: string,
    input?: { id?: string; title?: string; lastSurface?: string | null },
  ): Promise<ChatThreadSummary> {
    const id = input?.id
      ? assertValidDocId(input.id, 'thread_id')
      : adminDb().collection('chatThreads').doc().id;
    const ref = this.threadRef(id);

    return adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = snap.data() as ChatThreadSummary;
        if (existing.ownerUid !== uid) {
          throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
        }
        return existing;
      }
      const now = Date.now();
      const created: ChatThreadSummary = {
        id,
        ownerUid: uid,
        title: input?.title?.trim() ? input.title.trim().slice(0, 120) : 'New chat',
        lastInteractionId: null,
        lastSurface: input?.lastSurface ?? null,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(ref, stripUndefined(created));
      return created;
    });
  }

  async ensureThread(
    uid: string,
    input: { id: string; title?: string; lastSurface?: string | null },
  ): Promise<ChatThreadSummary> {
    return this.createThread(uid, input);
  }

  async updateThread(
    uid: string,
    threadId: string,
    patch: {
      title?: string;
      lastInteractionId?: string | null;
      lastSurface?: string | null;
      updatedAt?: number;
    },
  ): Promise<ChatThreadSummary> {
    const id = assertValidDocId(threadId, 'thread_id');
    const ref = this.threadRef(id);

    return adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.data() as ChatThreadSummary | undefined;
      if (!snap.exists || !existing || existing.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
      }
      const updated: ChatThreadSummary = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) || existing.title } : {}),
        ...(patch.lastInteractionId !== undefined ? { lastInteractionId: patch.lastInteractionId } : {}),
        ...(patch.lastSurface !== undefined ? { lastSurface: patch.lastSurface } : {}),
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      tx.set(ref, stripUndefined(updated));
      return updated;
    });
  }

  async deleteThread(uid: string, threadId: string): Promise<void> {
    const id = assertValidDocId(threadId, 'thread_id');
    const existing = await this.getThread(uid, id);
    if (!existing) {
      throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
    }

    const msgSnap = await this.messagesCol(id).get();
    const stagedSnap = await adminDb()
      .collection('chatStagedActions')
      .where('ownerUid', '==', uid)
      .where('threadId', '==', id)
      .get();

    const refs = [
      ...msgSnap.docs.map((d) => d.ref),
      ...stagedSnap.docs.map((d) => d.ref),
      this.threadRef(id),
    ];

    // Firestore batches allow up to 500 writes per batch.
    for (let i = 0; i < refs.length; i += 400) {
      const batch = adminDb().batch();
      for (const ref of refs.slice(i, i + 400)) {
        batch.delete(ref);
      }
      await batch.commit();
    }
  }

  async listMessages(uid: string, threadId: string, limit = 200): Promise<StoredChatMessage[]> {
    const id = assertValidDocId(threadId, 'thread_id');
    const existing = await this.getThread(uid, id);
    if (!existing) {
      throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
    }
    const cap = Math.min(Math.max(Math.floor(limit), 1), 500);
    const snap = await this.messagesCol(id).orderBy('createdAt', 'asc').limitToLast(cap).get();
    return snap.docs
      .map((doc) => doc.data() as StoredChatMessage)
      .filter((m) => m.ownerUid === uid);
  }

  async appendMessage(
    uid: string,
    threadId: string,
    message: StoredChatMessage,
    threadPatch?: {
      title?: string;
      lastInteractionId?: string | null;
      lastSurface?: string | null;
    },
  ): Promise<{ message: StoredChatMessage; thread: ChatThreadSummary }> {
    const id = assertValidDocId(threadId, 'thread_id');
    const msgId = assertValidDocId(message.id, 'message_id');
    if (message.ownerUid !== uid) {
      throw new ChatStoreError(403, 'forbidden', 'Message owner mismatch.');
    }

    const tRef = this.threadRef(id);
    const mRef = this.messagesCol(id).doc(msgId);

    return adminDb().runTransaction(async (tx) => {
      const [tSnap, mSnap] = await Promise.all([tx.get(tRef), tx.get(mRef)]);
      const existing = tSnap.data() as ChatThreadSummary | undefined;
      if (!tSnap.exists || !existing || existing.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
      }

      const prevMessage = mSnap.exists ? (mSnap.data() as StoredChatMessage | undefined) : undefined;
      const mergedMessage = mergePreservedActionCards(prevMessage, { ...message, id: msgId });
      const cleanMessage = stripUndefined(mergedMessage);
      const now = Math.max(Date.now(), cleanMessage.createdAt);
      const nextThread: ChatThreadSummary = {
        ...existing,
        ...(threadPatch?.title ? { title: threadPatch.title.trim().slice(0, 120) } : {}),
        ...(threadPatch?.lastInteractionId !== undefined
          ? { lastInteractionId: threadPatch.lastInteractionId }
          : {}),
        ...(threadPatch?.lastSurface !== undefined ? { lastSurface: threadPatch.lastSurface } : {}),
        messageCount: mSnap.exists ? existing.messageCount : existing.messageCount + 1,
        updatedAt: now,
      };

      tx.set(mRef, cleanMessage);
      tx.set(tRef, stripUndefined(nextThread));
      return { message: cleanMessage, thread: nextThread };
    });
  }

  async putStagedAction(uid: string, action: ChatStagedAction): Promise<ChatStagedAction> {
    if (action.ownerUid !== uid) {
      throw new ChatStoreError(403, 'forbidden', 'Staged action owner mismatch.');
    }
    const callId = assertValidDocId(action.callId, 'call_id');
    const ref = this.stagedRef(callId);

    return adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = snap.data() as ChatStagedAction;
        if (existing.ownerUid !== uid) {
          throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
        }
      }
      const clean = stripUndefined({ ...action, callId });
      tx.set(ref, clean);
      return clean;
    });
  }

  async getStagedAction(uid: string, callId: string): Promise<ChatStagedAction | null> {
    const id = assertValidDocId(callId, 'call_id');
    const snap = await this.stagedRef(id).get();
    if (!snap.exists) return null;
    const data = snap.data() as ChatStagedAction | undefined;
    if (!data || data.ownerUid !== uid) {
      throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
    }
    return data;
  }

  async getMessageActionCard(
    uid: string,
    threadId: string,
    messageId: string,
    callId: string,
  ): Promise<ActionCardPart | null> {
    const tId = assertValidDocId(threadId, 'thread_id');
    const mId = assertValidDocId(messageId, 'message_id');
    const existing = await this.getThread(uid, tId);
    if (!existing) return null;
    const snap = await this.messagesCol(tId).doc(mId).get();
    const msg = snap.data() as StoredChatMessage | undefined;
    if (!snap.exists || !msg || msg.ownerUid !== uid || !msg.resultParts) return null;
    return (
      msg.resultParts.find(
        (part): part is ActionCardPart => part.kind === 'action-card' && part.callId === callId,
      ) ?? null
    );
  }

  async updateMessageActionCard(
    uid: string,
    threadId: string,
    messageId: string,
    callId: string,
    updater: (
      card: ActionCardPart,
      action: ChatStagedAction | null,
    ) => { card: ActionCardPart; actionPatch?: StagedActionPatch },
  ): Promise<{ action: ChatStagedAction | null; card: ActionCardPart | null }> {
    const tId = assertValidDocId(threadId, 'thread_id');
    const mId = assertValidDocId(messageId, 'message_id');
    const cId = assertValidDocId(callId, 'call_id');

    const tRef = this.threadRef(tId);
    const mRef = this.messagesCol(tId).doc(mId);
    const sRef = this.stagedRef(cId);

    return adminDb().runTransaction(async (tx) => {
      const [tSnap, mSnap, sSnap] = await Promise.all([tx.get(tRef), tx.get(mRef), tx.get(sRef)]);
      const thread = tSnap.data() as ChatThreadSummary | undefined;
      if (!tSnap.exists || !thread || thread.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That chat thread is not available to you.');
      }

      const staged = sSnap.exists ? (sSnap.data() as ChatStagedAction) : null;
      if (staged && staged.ownerUid !== uid) {
        throw new ChatStoreError(404, 'not_found', 'That staged action is not available to you.');
      }

      const msg = mSnap.data() as StoredChatMessage | undefined;
      if (!mSnap.exists || !msg || msg.ownerUid !== uid) {
        return { action: staged, card: null };
      }

      const parts = [...(msg.resultParts ?? [])];
      const idx = parts.findIndex(
        (part): part is ActionCardPart => part.kind === 'action-card' && part.callId === cId,
      );
      if (idx < 0) {
        return { action: staged, card: null };
      }

      const { card: updatedCard, actionPatch } = updater(parts[idx] as ActionCardPart, staged);
      parts[idx] = stripUndefined(updatedCard);

      const nextMsg: StoredChatMessage = stripUndefined({
        ...msg,
        resultParts: parts,
      });
      tx.set(mRef, nextMsg);

      let nextAction = staged;
      if (nextAction && actionPatch) {
        nextAction = stripUndefined({
          ...nextAction,
          ...actionPatch,
          updatedAt: actionPatch.updatedAt ?? Date.now(),
        });
        tx.set(sRef, nextAction);
      }

      return { action: nextAction, card: updatedCard };
    });
  }
}

let testStoreOverride: ChatStorePort | null = null;
let prodSingleton: ChatStorePort | null = null;

export function setChatStoreForTests(store: ChatStorePort | null): void {
  testStoreOverride = store;
}

export function getServerChatStore(): ChatStorePort {
  if (testStoreOverride) return testStoreOverride;
  if (!prodSingleton) {
    prodSingleton = new FirestoreChatStore();
  }
  return prodSingleton;
}
