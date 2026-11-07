"use client";

/**
 * Ambient `ChatContextBridge` (`useSyncExternalStore` external store).
 *
 * Active Studio surfaces call `usePublishChatViewContext(snapshot, handlers)`
 * to publish their focal item metadata and imperative UI handlers (`seek`,
 * `insertMarkdown`, `patchComposerDraft`, `scrollToHeading`) without prop
 * drilling through Next.js route layouts.
 *
 * Playhead updates are exposed via a `getPlayheadSeconds` getter ref rather
 * than emitting store changes at 60fps: `ChatAmbientPill` samples at 1 Hz only
 * while visible, and message submission reads exact sub-second playhead time
 * on send.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ActiveViewContext, ComposerDraftKind } from './chat/types';

export interface ChatSurfaceHandlers {
  getPlayheadSeconds?: () => number | null;
  seek?: (seconds: number, play?: boolean) => void;
  togglePlay?: () => void;
  insertMarkdown?: (markdown: string, mode?: 'append' | 'cursor') => void;
  scrollToHeading?: (heading: string) => void;
  patchComposerDraft?: (draftKind: ComposerDraftKind, patch: Record<string, unknown>) => void;
}

interface PublisherEntry {
  id: symbol;
  snapshot: ActiveViewContext;
  handlers: ChatSurfaceHandlers;
}

const listeners = new Set<() => void>();
let stack: PublisherEntry[] = [];
let currentSnapshot: ActiveViewContext | null = null;

function notifyListeners() {
  const top = stack.length > 0 ? stack[stack.length - 1]! : null;
  const nextSnapshot = top ? top.snapshot : null;
  if (shallowEqualContext(currentSnapshot, nextSnapshot)) return;
  currentSnapshot = nextSnapshot;
  for (const listener of listeners) {
    listener();
  }
}

function shallowEqualContext(a: ActiveViewContext | null, b: ActiveViewContext | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as (keyof ActiveViewContext)[];
  const keysB = Object.keys(b) as (keyof ActiveViewContext)[];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ActiveViewContext | null {
  return currentSnapshot;
}

function getServerSnapshot(): ActiveViewContext | null {
  return null;
}

export function registerChatViewPublisher(
  id: symbol,
  snapshot: ActiveViewContext | null,
  handlers: ChatSurfaceHandlers = {},
): void {
  const existingIdx = stack.findIndex((entry) => entry.id === id);
  if (snapshot === null) {
    if (existingIdx !== -1) {
      stack = stack.filter((entry) => entry.id !== id);
      notifyListeners();
    }
    return;
  }
  if (existingIdx !== -1) {
    const prev = stack[existingIdx]!;
    stack[existingIdx] = { id, snapshot, handlers };
    if (!shallowEqualContext(prev.snapshot, snapshot)) {
      notifyListeners();
    }
  } else {
    stack = [...stack, { id, snapshot, handlers }];
    notifyListeners();
  }
}

export function unregisterChatViewPublisher(id: symbol): void {
  if (!stack.some((entry) => entry.id === id)) return;
  stack = stack.filter((entry) => entry.id !== id);
  notifyListeners();
}

export function resetChatContextBridgeForTests(): void {
  stack = [];
  currentSnapshot = null;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Reads the active `ActiveViewContext`, merging the live `getPlayheadSeconds()`
 * value if the active surface provides a playhead getter.
 */
export function readSnapshotWithLivePlayhead(): ActiveViewContext | null {
  const top = stack.length > 0 ? stack[stack.length - 1]! : null;
  if (!top) return null;
  const livePlayhead = top.handlers.getPlayheadSeconds?.();
  if (livePlayhead === undefined) return top.snapshot;
  if (
    top.snapshot.surface === 'analysis' ||
    top.snapshot.surface === 'narration' ||
    top.snapshot.surface === 'video' ||
    top.snapshot.surface === 'music' ||
    top.snapshot.surface === 'cut'
  ) {
    return { ...top.snapshot, playheadSeconds: livePlayhead };
  }
  return top.snapshot;
}

export function getActiveChatSurfaceHandlers(): ChatSurfaceHandlers {
  const top = stack.length > 0 ? stack[stack.length - 1]! : null;
  return top ? top.handlers : {};
}

export function seekActiveChatSurface(seconds: number, play?: boolean): boolean {
  const handlers = getActiveChatSurfaceHandlers();
  if (!handlers.seek) return false;
  handlers.seek(seconds, play);
  return true;
}

/**
 * React hook for active Studio surfaces to publish their ambient context and
 * imperative action handlers.
 */
export function usePublishChatViewContext(
  snapshot: ActiveViewContext | null,
  handlers: ChatSurfaceHandlers = {},
): void {
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) {
    idRef.current = Symbol('chat-view-publisher');
  }
  const handlersRef = useRef<ChatSurfaceHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const id = idRef.current!;
    const stableHandlers: ChatSurfaceHandlers = {
      getPlayheadSeconds: () => handlersRef.current.getPlayheadSeconds?.() ?? null,
      seek: (s, p) => handlersRef.current.seek?.(s, p),
      togglePlay: () => handlersRef.current.togglePlay?.(),
      insertMarkdown: (md, mode) => handlersRef.current.insertMarkdown?.(md, mode),
      scrollToHeading: (h) => handlersRef.current.scrollToHeading?.(h),
      patchComposerDraft: (k, patch) => handlersRef.current.patchComposerDraft?.(k, patch),
    };
    registerChatViewPublisher(id, snapshot, {
      getPlayheadSeconds: handlers.getPlayheadSeconds ? stableHandlers.getPlayheadSeconds : undefined,
      seek: handlers.seek ? stableHandlers.seek : undefined,
      togglePlay: handlers.togglePlay ? stableHandlers.togglePlay : undefined,
      insertMarkdown: handlers.insertMarkdown ? stableHandlers.insertMarkdown : undefined,
      scrollToHeading: handlers.scrollToHeading ? stableHandlers.scrollToHeading : undefined,
      patchComposerDraft: handlers.patchComposerDraft ? stableHandlers.patchComposerDraft : undefined,
    });
  }, [
    snapshot,
    Boolean(handlers.getPlayheadSeconds),
    Boolean(handlers.seek),
    Boolean(handlers.togglePlay),
    Boolean(handlers.insertMarkdown),
    Boolean(handlers.scrollToHeading),
    Boolean(handlers.patchComposerDraft),
  ]);

  useEffect(() => {
    const id = idRef.current!;
    return () => {
      unregisterChatViewPublisher(id);
    };
  }, []);
}

export function useActiveChatViewContext(): ActiveViewContext | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
