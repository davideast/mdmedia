"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";
import type { Draft } from "@/components/shell/narration-provider";
import { DEFAULT_ANALYSIS_DRAFT, readAnalysisDraft } from "@/lib/analysis-draft";
import {
  getActiveChatSurfaceHandlers,
  readSnapshotWithLivePlayhead,
  seekActiveChatSurface,
  useActiveChatViewContext,
} from "@/lib/chat-context-bridge";
import { useOptionalAuth } from "@/lib/auth-context";
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  formatActiveViewPillLabel,
  isChatEffortLevel,
  isChatModelName,
  type ActiveViewContext,
  type ActionCardState,
  type CardActionDescriptor,
  type ChatEffortLevel,
  type ChatEntityReference,
  type ChatMediaType,
  type ChatModelName,
  type ChatResultPart,
  type ChatShellController,
  type ChatSseEvent,
  type ChatThreadSummary,
  type ClientActionPayload,
  type ComposerDraftKind,
  type ConfirmStagedActionOverrides,
  type RightColumnMode,
  type SlashCommandId,
  type StoredChatMessage,
} from "@/lib/chat/types";
import { STUDIO_MUTATION_EVENT, studioFetch, studioJson } from "@/lib/media-client";
import { formatMediaMarkdownRef } from "@/lib/tree-helpers";
import { DEFAULT_VIDEO_REQUEST } from "@/lib/video-request";
import { DEFAULT_MUSIC_REQUEST } from "@/lib/music-request";

const RIGHT_MODE_STORAGE_KEY = "mdmedia.chat.rightMode.v1";
const THREAD_ID_STORAGE_KEY = "mdmedia.chat.threadId.v1";
const CHAT_MODEL_STORAGE_KEY = "mdmedia.chat.model.v1";
const CHAT_EFFORT_STORAGE_KEY = "mdmedia.chat.effort.v1";

export interface ChatShellAdapter {
  expandRightPanel: () => void;
  collapseRightPanel: () => void;
  isRightPanelExpanded: () => boolean;
}

export interface ChatContextValue extends ChatShellController {
  registerShellAdapter: (adapter: ChatShellAdapter) => () => void;
  composerFocusSeq: number;
  requestComposerFocus: () => void;
  threads: ChatThreadSummary[];
  threadsLoading: boolean;
  activeThreadId: string | null;
  activeThreadTitle: string | null;
  messages: StoredChatMessage[];
  streaming: boolean;
  streamingText: string;
  streamingThoughtHeadline: string | null;
  streamingThoughtSteps: string[];
  streamingThoughtDurationMs: number | null;
  streamingToolLabel: string | null;
  streamingParts: ChatResultPart[];
  errorMessage: string | null;
  ambientMuted: boolean;
  setAmbientMuted: (muted: boolean) => void;
  chatModel: ChatModelName;
  chatEffort: ChatEffortLevel;
  setChatModel: (model: ChatModelName) => void;
  setChatEffort: (effort: ChatEffortLevel) => void;
  pendingSlashCommand: SlashCommandId | null;
  setPendingSlashCommand: (cmd: SlashCommandId | null) => void;
  startNewThread: () => void;
  selectThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (input: {
    text: string;
    slashCommand?: SlashCommandId | null;
    references?: ChatEntityReference[];
  }) => Promise<void>;
  cancelStream: () => void;
  confirmCardAction: (
    callId: string,
    overrides?: ConfirmStagedActionOverrides,
  ) => Promise<void>;
  runCardClientAction: (descriptor: CardActionDescriptor) => void;
  stageDocInsertFromEmbed: (params: {
    mediaType: ChatMediaType;
    itemId: string;
    title: string;
  }) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function computeViewPrimaryKey(ctx: ActiveViewContext | null): string {
  if (!ctx) return "none";
  switch (ctx.surface) {
    case "analysis":
    case "narration":
    case "video":
    case "image":
    case "music":
      return `${ctx.surface}:${ctx.itemId}`;
    case "tree-doc":
      return `tree-doc:${ctx.treeId}:${ctx.docPath}`;
    case "composer":
      return `composer:${ctx.draftKind}:${ctx.route}`;
    case "cut":
      return `cut:${ctx.productionId}:${ctx.cutId}`;
    case "storyboard":
      return `storyboard:${ctx.storyboardId}`;
    case "playlist":
    case "library":
    case "activity":
      return `${ctx.surface}:${ctx.route}`;
  }
}

function parseSseFrames(buffer: string): {
  frames: Array<{ event: string; data: string }>;
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const frames: Array<{ event: string; data: string }> = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event: eventName, data: dataLines.join("\n") });
    }
  }

  return { frames, remainder };
}

function deriveDraftIdFromHref(href: string): string {
  try {
    const url = new URL(href, "https://workspace.local");
    return url.searchParams.get("draft") || "default";
  } catch {
    return "default";
  }
}

function updateActionCardInParts(
  parts: readonly ChatResultPart[] | undefined,
  callId: string,
  updater: (
    card: Extract<ChatResultPart, { kind: "action-card" }>,
  ) => Extract<ChatResultPart, { kind: "action-card" }>,
): ChatResultPart[] | undefined {
  if (!parts) return parts;
  let changed = false;
  const next = parts.map((part) => {
    if (part.kind === "action-card" && part.callId === callId) {
      changed = true;
      return updater(part);
    }
    return part;
  });
  return changed ? next : [...parts];
}

export function ChatProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const workspace = useOptionalWorkspace();
  const authState = useOptionalAuth();
  const activeViewContext = useActiveChatViewContext();

  // Fresh sessions keep `chatOpen === false` so catalog routes start with a 0px right column.
  const [chatOpen, setChatOpen] = useState(false);
  const [rightMode, setRightModeState] = useState<RightColumnMode>("inspector");
  const [composerFocusSeq, setComposerFocusSeq] = useState(0);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThreadTitle, setActiveThreadTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThoughtHeadline, setStreamingThoughtHeadline] = useState<string | null>(
    null,
  );
  const [streamingThoughtSteps, setStreamingThoughtSteps] = useState<string[]>([]);
  const [streamingThoughtDurationMs, setStreamingThoughtDurationMs] = useState<
    number | null
  >(null);
  const [streamingToolLabel, setStreamingToolLabel] = useState<string | null>(null);
  const [streamingParts, setStreamingParts] = useState<ChatResultPart[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [ambientMuted, setAmbientMuted] = useState(false);
  const [chatModel, setChatModelState] = useState<ChatModelName>(DEFAULT_CHAT_MODEL);
  const [chatEffort, setChatEffortState] = useState<ChatEffortLevel>(DEFAULT_CHAT_EFFORT);
  const [pendingSlashCommand, setPendingSlashCommand] = useState<SlashCommandId | null>(
    null,
  );

  const shellAdapterRef = useRef<ChatShellAdapter | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const initialHydratedRef = useRef(false);
  const threadsLoadedOnceRef = useRef(false);
  const initialStoredThreadLoadedRef = useRef(false);

  // Hydrate stored preferences on mount without opening chat automatically.
  useEffect(() => {
    if (initialHydratedRef.current) return;
    initialHydratedRef.current = true;
    try {
      const savedMode = window.localStorage.getItem(RIGHT_MODE_STORAGE_KEY);
      if (savedMode === "chat" || savedMode === "inspector") {
        setRightModeState(savedMode);
      }
      const savedThreadId = window.localStorage.getItem(THREAD_ID_STORAGE_KEY);
      if (savedThreadId && savedThreadId.trim()) {
        setActiveThreadId(savedThreadId.trim());
      }
      const savedChatModel = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
      if (isChatModelName(savedChatModel)) {
        setChatModelState(savedChatModel);
      }
      const savedChatEffort = window.localStorage.getItem(CHAT_EFFORT_STORAGE_KEY);
      if (isChatEffortLevel(savedChatEffort)) {
        setChatEffortState(savedChatEffort);
      }
    } catch {
      /* Ignore storage access issues in restricted contexts. */
    }
  }, []);

  const profileChatModel = authState?.profile?.settings.chatModel;
  const profileChatEffort = authState?.profile?.settings.chatEffort;

  useEffect(() => {
    if (profileChatModel && isChatModelName(profileChatModel)) {
      setChatModelState(profileChatModel);
    }
  }, [profileChatModel]);

  useEffect(() => {
    if (profileChatEffort && isChatEffortLevel(profileChatEffort)) {
      setChatEffortState(profileChatEffort);
    }
  }, [profileChatEffort]);

  const setChatModel = useCallback(
    (nextModel: ChatModelName) => {
      if (!isChatModelName(nextModel)) return;
      setChatModelState(nextModel);
      try {
        window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, nextModel);
      } catch {
        /* Ignore storage errors. */
      }
      if (authState?.user) {
        void authState.updateSettings({ chatModel: nextModel });
      }
    },
    [authState],
  );

  const setChatEffort = useCallback(
    (nextEffort: ChatEffortLevel) => {
      if (!isChatEffortLevel(nextEffort)) return;
      setChatEffortState(nextEffort);
      try {
        window.localStorage.setItem(CHAT_EFFORT_STORAGE_KEY, nextEffort);
      } catch {
        /* Ignore storage errors. */
      }
      if (authState?.user) {
        void authState.updateSettings({ chatEffort: nextEffort });
      }
    },
    [authState],
  );

  const persistRightMode = useCallback((mode: RightColumnMode) => {
    try {
      window.localStorage.setItem(RIGHT_MODE_STORAGE_KEY, mode);
    } catch {
      /* Ignore storage errors. */
    }
  }, []);

  const persistActiveThreadId = useCallback((threadId: string | null) => {
    try {
      if (threadId) {
        window.localStorage.setItem(THREAD_ID_STORAGE_KEY, threadId);
      } else {
        window.localStorage.removeItem(THREAD_ID_STORAGE_KEY);
      }
    } catch {
      /* Ignore storage errors. */
    }
  }, []);

  // Reset `ambientMuted` automatically when the primary focal route/item changes.
  const viewKey = computeViewPrimaryKey(activeViewContext);
  const prevViewKeyRef = useRef(viewKey);
  useEffect(() => {
    if (prevViewKeyRef.current !== viewKey) {
      prevViewKeyRef.current = viewKey;
      setAmbientMuted(false);
    }
  }, [viewKey]);

  const registerShellAdapter = useCallback((adapter: ChatShellAdapter) => {
    shellAdapterRef.current = adapter;
    return () => {
      if (shellAdapterRef.current === adapter) {
        shellAdapterRef.current = null;
      }
    };
  }, []);

  const requestComposerFocus = useCallback(() => {
    setComposerFocusSeq((seq) => seq + 1);
  }, []);

  const openChat = useCallback(
    (options?: { focusComposer?: boolean; initialSlashCommand?: SlashCommandId }) => {
      setChatOpen(true);
      setRightModeState("chat");
      persistRightMode("chat");
      shellAdapterRef.current?.expandRightPanel();
      if (options?.initialSlashCommand) {
        setPendingSlashCommand(options.initialSlashCommand);
      }
      if (options?.focusComposer !== false) {
        setComposerFocusSeq((seq) => seq + 1);
      }
    },
    [persistRightMode],
  );

  const closeChat = useCallback(() => {
    setChatOpen(false);
    setRightModeState("inspector");
    persistRightMode("inspector");
    shellAdapterRef.current?.collapseRightPanel();
  }, [persistRightMode]);

  const setRightMode = useCallback(
    (mode: RightColumnMode) => {
      setRightModeState(mode);
      persistRightMode(mode);
      if (mode === "chat") {
        setChatOpen(true);
        shellAdapterRef.current?.expandRightPanel();
        setComposerFocusSeq((seq) => seq + 1);
      }
    },
    [persistRightMode],
  );

  const toggleChat = useCallback(() => {
    const isExpanded = shellAdapterRef.current
      ? shellAdapterRef.current.isRightPanelExpanded()
      : true;
    if (chatOpen && rightMode === "chat" && isExpanded) {
      closeChat();
    } else {
      openChat({ focusComposer: true });
    }
  }, [chatOpen, rightMode, closeChat, openChat]);

  // Global keyboard shortcut: Cmd/Ctrl + J (and secondary Cmd/Ctrl + .).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === "j" || event.key === ".")
      ) {
        event.preventDefault();
        toggleChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleChat]);

  const navigateInStudio = useCallback(
    (href: string) => {
      if (!href) return;
      if (workspace) {
        const tab = workspace.store.visit(href);
        if (tab) {
          workspace.openView(tab);
          return;
        }
      }
      router.push(href, { scroll: false });
    },
    [workspace, router],
  );

  const applyDraftPatchToWorkspace = useCallback(
    (draftKind: ComposerDraftKind, href: string, patch: Record<string, unknown>) => {
      const surfaceHandlers = getActiveChatSurfaceHandlers();
      surfaceHandlers.patchComposerDraft?.(draftKind, patch);

      if (workspace) {
        const targetDraftId = deriveDraftIdFromHref(href);
        if (draftKind === "narration") {
          const narrationPatch: Partial<Draft> = {};
          if (typeof patch.markdown === "string") narrationPatch.markdown = patch.markdown;
          if (typeof patch.input === "string" && !narrationPatch.markdown) {
            narrationPatch.markdown = patch.input;
          }
          if (typeof patch.promptStyle === "string") {
            narrationPatch.promptStyle = patch.promptStyle;
          }
          workspace.store.setDraft(targetDraftId, narrationPatch);
        } else if (draftKind === "image") {
          const existing = workspace.state.imageDrafts?.[targetDraftId];
          workspace.store.setImageDraft(targetDraftId, {
            kind: "image",
            prompt:
              typeof patch.prompt === "string" ? patch.prompt : existing?.prompt ?? "",
            aspectRatio:
              typeof patch.aspectRatio === "string"
                ? patch.aspectRatio
                : existing?.aspectRatio ?? "16:9",
            resolution:
              typeof patch.resolution === "string"
                ? patch.resolution
                : existing?.resolution ?? "",
            adapt:
              typeof patch.adapt === "boolean" ? patch.adapt : existing?.adapt ?? false,
            instructions:
              typeof patch.instructions === "string"
                ? patch.instructions
                : existing?.instructions ?? "",
            referenceAssetId:
              typeof patch.referenceAssetId === "string"
                ? patch.referenceAssetId
                : existing?.referenceAssetId ?? null,
            ...(typeof patch.model === "string"
              ? { model: patch.model }
              : existing?.model
                ? { model: existing.model }
                : {}),
          });
        } else if (draftKind === "video") {
          const existing = workspace.state.videoDrafts?.[targetDraftId];
          const base = existing ?? { kind: "video" as const, ...DEFAULT_VIDEO_REQUEST };
          workspace.store.setVideoDraft(targetDraftId, {
            ...base,
            prompt: typeof patch.prompt === "string" ? patch.prompt : base.prompt,
            output: {
              ...base.output,
              ...(typeof patch.aspectRatio === "string" &&
              (patch.aspectRatio === "16:9" || patch.aspectRatio === "9:16")
                ? { aspectRatio: patch.aspectRatio }
                : {}),
              ...(typeof patch.durationSeconds === "number"
                ? { durationSeconds: patch.durationSeconds }
                : {}),
            },
            ...(typeof patch.referenceAssetId === "string"
              ? { referenceAssetId: patch.referenceAssetId }
              : {}),
          });
        } else if (draftKind === "music") {
          const existing = workspace.state.musicDrafts?.[targetDraftId];
          const base = existing ?? { kind: "music" as const, ...DEFAULT_MUSIC_REQUEST };
          workspace.store.setMusicDraft(targetDraftId, {
            ...base,
            prompt: typeof patch.prompt === "string" ? patch.prompt : base.prompt,
            lyrics: typeof patch.lyrics === "string" ? patch.lyrics : base.lyrics,
            ...(patch.instrumental === true ? { vocals: "instrumental" } : {}),
          });
        } else if (draftKind === "analysis") {
          const existing =
            workspace.state.analysisDrafts?.[targetDraftId] ?? DEFAULT_ANALYSIS_DRAFT;
          const merged =
            readAnalysisDraft({
              ...existing,
              ...patch,
              kind: "analysis",
            }) ?? {
              ...existing,
              prompt: typeof patch.prompt === "string" ? patch.prompt : existing.prompt,
            };
          workspace.store.setAnalysisDraft(targetDraftId, merged);
        }
      }

      navigateInStudio(href);
    },
    [workspace, navigateInStudio],
  );

  const executeClientAction = useCallback(
    (action: ClientActionPayload) => {
      switch (action.kind) {
        case "open_route":
          navigateInStudio(action.href);
          break;
        case "seek_media":
          seekActiveChatSurface(action.seconds, action.play);
          break;
        case "prefill_draft":
          applyDraftPatchToWorkspace(action.draftKind, action.href, action.patch);
          break;
        case "insert_markdown":
          getActiveChatSurfaceHandlers().insertMarkdown?.(action.markdown, action.mode);
          break;
      }
    },
    [navigateInStudio, applyDraftPatchToWorkspace],
  );

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!threadId) return;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setStreaming(false);
      setErrorMessage(null);
      setActiveThreadId(threadId);
      persistActiveThreadId(threadId);

      try {
        const res = await studioJson<{
          thread?: ChatThreadSummary;
          id?: string;
          title?: string;
          messages?: StoredChatMessage[];
        }>(`/api/v1/chat/threads/${encodeURIComponent(threadId)}`);
        const resolvedTitle = res.thread?.title ?? res.title ?? null;
        setActiveThreadTitle(resolvedTitle);
        setMessages(Array.isArray(res.messages) ? res.messages : []);
      } catch (err) {
        // If a stale stored thread was deleted or doesn't exist yet, fall back cleanly.
        if (err && typeof err === "object" && "status" in err && err.status === 404) {
          setActiveThreadId(null);
          setActiveThreadTitle(null);
          setMessages([]);
          persistActiveThreadId(null);
          return;
        }
        setErrorMessage(
          err instanceof Error ? err.message : "Could not load chat thread.",
        );
      }
    },
    [persistActiveThreadId],
  );

  // Lazy load thread summaries when Chat is first opened.
  useEffect(() => {
    if (!chatOpen && rightMode !== "chat") return;
    if (threadsLoadedOnceRef.current) return;
    threadsLoadedOnceRef.current = true;

    let cancelled = false;
    setThreadsLoading(true);

    void studioJson<
      | ChatThreadSummary[]
      | { threads?: ChatThreadSummary[]; items?: ChatThreadSummary[] }
    >("/api/v1/chat/threads")
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res : (res.threads ?? res.items ?? []);
        setThreads(list);
      })
      .catch(() => {
        /* Quiet failure on initial list load; sending still works. */
      })
      .finally(() => {
        if (!cancelled) setThreadsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chatOpen, rightMode]);

  // Lazy hydrate stored active thread messages when Chat opens.
  useEffect(() => {
    if (!chatOpen && rightMode !== "chat") return;
    if (initialStoredThreadLoadedRef.current) return;
    initialStoredThreadLoadedRef.current = true;
    if (activeThreadId && messages.length === 0 && !streaming) {
      void selectThread(activeThreadId);
    }
  }, [chatOpen, rightMode, activeThreadId, messages.length, streaming, selectThread]);

  const clearStreamingBuffers = useCallback(() => {
    setStreamingText("");
    setStreamingThoughtHeadline(null);
    setStreamingThoughtSteps([]);
    setStreamingThoughtDurationMs(null);
    setStreamingToolLabel(null);
    setStreamingParts([]);
  }, []);

  const cancelStream = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreaming(false);
  }, []);

  const startNewThread = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreaming(false);
    clearStreamingBuffers();
    setErrorMessage(null);
    setActiveThreadId(null);
    setActiveThreadTitle(null);
    setMessages([]);
    persistActiveThreadId(null);
    setComposerFocusSeq((seq) => seq + 1);
  }, [clearStreamingBuffers, persistActiveThreadId]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      setThreads((prev) => prev.filter((item) => item.id !== threadId));
      if (activeThreadId === threadId) {
        startNewThread();
      }
      try {
        await studioFetch(`/api/v1/chat/threads/${encodeURIComponent(threadId)}`, {
          method: "DELETE",
        });
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "Could not delete chat thread.",
        );
      }
    },
    [activeThreadId, startNewThread],
  );

  const sendMessage = useCallback(
    async ({
      text,
      slashCommand = null,
      references,
    }: {
      text: string;
      slashCommand?: SlashCommandId | null;
      references?: ChatEntityReference[];
    }) => {
      if (slashCommand === "new" || text.trim() === "/new") {
        startNewThread();
        return;
      }

      const trimmedText = text.trim();
      const hasRefs = Boolean(references && references.length > 0);
      const effectivePrompt =
        trimmedText ||
        (slashCommand ? `/${slashCommand}` : "") ||
        (hasRefs ? references!.map((r) => `#${r.title}`).join(" ") : "");
      if (!effectivePrompt || streaming) return;

      const threadId = activeThreadId ?? crypto.randomUUID();
      if (!activeThreadId) {
        setActiveThreadId(threadId);
        persistActiveThreadId(threadId);
      }

      const viewSnapshot = ambientMuted ? null : readSnapshotWithLivePlayhead();
      const pillLabel = viewSnapshot ? formatActiveViewPillLabel(viewSnapshot) : null;
      const contextBadge = pillLabel
        ? { label: pillLabel, href: viewSnapshot?.route }
        : null;

      const optimisticUserMessage: StoredChatMessage = {
        id: `local_user_${crypto.randomUUID()}`,
        ownerUid: "self",
        role: "user",
        text: trimmedText,
        slashCommand: slashCommand ?? null,
        contextBadge,
        ...(hasRefs ? { references } : {}),
        createdAt: Date.now(),
      };

      setMessages((prev) => [...prev, optimisticUserMessage]);
      setErrorMessage(null);
      clearStreamingBuffers();
      setStreaming(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Local accumulators for clean partial turn recovery if stream ends without turn.done
      let accText = "";
      let accSteps: string[] = [];
      let accDurationMs: number | null = null;
      let accParts: ChatResultPart[] = [];
      let receivedTurnDone = false;

      const handleEvent = (rawEventName: string, rawData: string) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(rawData) as Record<string, unknown>;
        } catch {
          return;
        }
        const eventType = (
          typeof parsed.type === "string" ? parsed.type : rawEventName
        ) as ChatSseEvent["type"];

        switch (eventType) {
          case "turn.start": {
            const serverThreadId =
              typeof parsed.threadId === "string" ? parsed.threadId : threadId;
            if (serverThreadId !== threadId) {
              setActiveThreadId(serverThreadId);
              persistActiveThreadId(serverThreadId);
            }
            break;
          }
          case "thought.delta": {
            const headline =
              typeof parsed.headline === "string"
                ? parsed.headline.trim()
                : typeof parsed.summaryLine === "string"
                  ? parsed.summaryLine.trim()
                  : "";
            const delta =
              typeof parsed.delta === "string" ? parsed.delta.trim() : "";
            const nextHeadline = headline || delta.split("\n")[0]?.trim() || "";
            if (nextHeadline) {
              setStreamingThoughtHeadline(nextHeadline);
              if (accSteps[accSteps.length - 1] !== nextHeadline) {
                accSteps = [...accSteps, nextHeadline];
                setStreamingThoughtSteps(accSteps);
              }
            }
            break;
          }
          case "thought.done": {
            const durationMs =
              typeof parsed.durationMs === "number" ? parsed.durationMs : 0;
            accDurationMs = durationMs;
            setStreamingThoughtDurationMs(durationMs);
            break;
          }
          case "tool.start": {
            const label =
              typeof parsed.label === "string"
                ? parsed.label
                : typeof parsed.toolName === "string"
                  ? `Running ${parsed.toolName.replace(/_/g, " ")}…`
                  : "Working…";
            setStreamingToolLabel(label);
            break;
          }
          case "client.action": {
            const payload = (
              parsed.action && typeof parsed.action === "object"
                ? parsed.action
                : parsed
            ) as ClientActionPayload;
            if (payload && typeof payload.kind === "string") {
              executeClientAction(payload);
            }
            break;
          }
          case "tool.result": {
            const incomingParts = Array.isArray(parsed.parts)
              ? (parsed.parts as ChatResultPart[])
              : parsed.part && typeof parsed.part === "object"
                ? [parsed.part as ChatResultPart]
                : [];
            if (incomingParts.length > 0) {
              accParts = [...accParts, ...incomingParts];
              setStreamingParts(accParts);
            }
            setStreamingToolLabel(null);
            break;
          }
          case "text.delta": {
            const deltaText = typeof parsed.text === "string" ? parsed.text : "";
            if (deltaText) {
              accText += deltaText;
              setStreamingText(accText);
            }
            break;
          }
          case "turn.done": {
            receivedTurnDone = true;
            const serverMsg = (parsed.assistantMessage ??
              parsed.message) as StoredChatMessage | undefined;
            const threadTitle =
              typeof parsed.threadTitle === "string" ? parsed.threadTitle : null;
            const finalAssistant: StoredChatMessage = serverMsg ?? {
              id: `local_assistant_${crypto.randomUUID()}`,
              ownerUid: "self",
              role: "assistant",
              text: accText,
              thoughtSummary:
                accSteps.length > 0 || accDurationMs !== null
                  ? { durationMs: accDurationMs ?? 0, steps: accSteps }
                  : null,
              resultParts: accParts.length > 0 ? accParts : undefined,
              createdAt: Date.now(),
            };

            setMessages((prev) => [...prev, finalAssistant]);
            if (threadTitle) {
              setActiveThreadTitle(threadTitle);
            }
            const resolvedTitle =
              threadTitle ||
              activeThreadTitle ||
              trimmedText.slice(0, 48) ||
              "Chat";
            const now = Date.now();
            setThreads((prev) => {
              const existing = prev.find((t) => t.id === threadId);
              const updated: ChatThreadSummary = existing
                ? {
                    ...existing,
                    title: resolvedTitle,
                    messageCount: existing.messageCount + 2,
                    updatedAt: now,
                  }
                : {
                    id: threadId,
                    ownerUid: finalAssistant.ownerUid || "self",
                    title: resolvedTitle,
                    lastInteractionId: finalAssistant.interactionId ?? null,
                    lastSurface: viewSnapshot?.surface ?? null,
                    messageCount: 2,
                    createdAt: now,
                    updatedAt: now,
                  };
              return [updated, ...prev.filter((t) => t.id !== threadId)];
            });
            clearStreamingBuffers();
            break;
          }
          case "turn.error": {
            const msg =
              typeof parsed.message === "string"
                ? parsed.message
                : "Studio chat encountered an error.";
            setErrorMessage(msg);
            break;
          }
        }
      };

      try {
        const response = await studioFetch(
          `/api/v1/chat/threads/${encodeURIComponent(threadId)}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              message: trimmedText,
              text: trimmedText,
              slashCommand: slashCommand ?? null,
              ...(hasRefs ? { references } : {}),
              model: chatModel,
              effort: chatEffort,
              viewContext: viewSnapshot,
              contextBadge,
              threadTitleHint:
                activeThreadTitle ?? effectivePrompt.slice(0, 48),
            }),
            signal: controller.signal,
          },
        );

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream") && response.body) {
          // Handle non-streaming JSON fallback if returned
          const json = (await response.json().catch(() => null)) as {
            assistantMessage?: StoredChatMessage;
            threadTitle?: string;
          } | null;
          if (json?.assistantMessage) {
            handleEvent("turn.done", JSON.stringify(json));
          }
        } else if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let sseBuffer = "";

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const { frames, remainder } = parseSseFrames(sseBuffer);
            sseBuffer = remainder;
            for (const frame of frames) {
              handleEvent(frame.event, frame.data);
            }
          }
          sseBuffer += decoder.decode();
          if (sseBuffer.trim()) {
            const { frames } = parseSseFrames(`${sseBuffer}\n\n`);
            for (const frame of frames) {
              handleEvent(frame.event, frame.data);
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          if (accText || accParts.length > 0) {
            const partialMessage: StoredChatMessage = {
              id: `partial_${crypto.randomUUID()}`,
              ownerUid: "self",
              role: "assistant",
              text: accText,
              thoughtSummary:
                accSteps.length > 0
                  ? { durationMs: accDurationMs ?? 0, steps: accSteps }
                  : null,
              resultParts: accParts.length > 0 ? accParts : undefined,
              createdAt: Date.now(),
            };
            setMessages((prev) => [...prev, partialMessage]);
          }
          clearStreamingBuffers();
          return;
        }
        setErrorMessage(
          err instanceof Error ? err.message : "Could not complete chat turn.",
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (!receivedTurnDone && (accText || accParts.length > 0) && !controller.signal.aborted) {
          const fallbackMessage: StoredChatMessage = {
            id: `assistant_${crypto.randomUUID()}`,
            ownerUid: "self",
            role: "assistant",
            text: accText,
            thoughtSummary:
              accSteps.length > 0
                ? { durationMs: accDurationMs ?? 0, steps: accSteps }
                : null,
            resultParts: accParts.length > 0 ? accParts : undefined,
            createdAt: Date.now(),
          };
          setMessages((prev) => [...prev, fallbackMessage]);
          clearStreamingBuffers();
        }
        setStreaming(false);
      }
    },
    [
      activeThreadId,
      activeThreadTitle,
      ambientMuted,
      chatEffort,
      chatModel,
      clearStreamingBuffers,
      executeClientAction,
      persistActiveThreadId,
      startNewThread,
      streaming,
    ],
  );

  const confirmCardAction = useCallback(
    async (callId: string, overrides?: ConfirmStagedActionOverrides) => {
      const applyUpdate = (
        updater: (
          card: Extract<ChatResultPart, { kind: "action-card" }>,
        ) => Extract<ChatResultPart, { kind: "action-card" }>,
      ) => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.resultParts
              ? {
                  ...msg,
                  resultParts: updateActionCardInParts(msg.resultParts, callId, updater),
                }
              : msg,
          ),
        );
        setStreamingParts((prev) => updateActionCardInParts(prev, callId, updater) ?? prev);
      };

      applyUpdate((card) => ({
        ...card,
        state: "queued",
        errorMessage: null,
      }));

      try {
        const res = await studioJson<{
          card?: Extract<ChatResultPart, { kind: "action-card" }>;
          actionCard?: Extract<ChatResultPart, { kind: "action-card" }>;
          state?: ActionCardState;
          generationId?: string | null;
          itemId?: string | null;
          targetRoute?: string | null;
        }>(`/api/v1/chat/actions/${encodeURIComponent(callId)}/confirm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `chat:${callId}`,
          },
          body: JSON.stringify(overrides ?? {}),
        });

      const returnedCard = res.card ?? res.actionCard;
      applyUpdate((card) =>
        returnedCard
          ? returnedCard
          : {
              ...card,
              state: res.state ?? (res.generationId ? "running" : "succeeded"),
              generationId: res.generationId ?? card.generationId,
              itemId: res.itemId ?? card.itemId,
              targetRoute: res.targetRoute ?? card.targetRoute,
            },
      );

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(STUDIO_MUTATION_EVENT));
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not run staged action.";
      applyUpdate((card) => ({
        ...card,
        state: "failed",
        errorMessage: message,
      }));
    }
  }, []);

  const stageDocInsertFromEmbed = useCallback(
    async ({
      mediaType,
      itemId,
      title,
    }: {
      mediaType: ChatMediaType;
      itemId: string;
      title: string;
    }) => {
      const markdownRef = formatMediaMarkdownRef(
        { type: mediaType, id: itemId },
        title || "Media",
      );
      const handlers = getActiveChatSurfaceHandlers();
      if (handlers.insertMarkdown) {
        handlers.insertMarkdown(`\n\n${markdownRef}\n`, "cursor");
        return;
      }
      await sendMessage({
        text: `Insert ${markdownRef} into the active document`,
        slashCommand: "doc",
      });
    },
    [sendMessage],
  );

  const runCardClientAction = useCallback(
    (descriptor: CardActionDescriptor) => {
      switch (descriptor.kind) {
        case "confirm":
          break;
        case "edit-in-studio":
          applyDraftPatchToWorkspace(
            descriptor.draftKind,
            descriptor.href,
            descriptor.patch,
          );
          break;
        case "open-route":
          navigateInStudio(descriptor.href);
          break;
        case "seek":
          seekActiveChatSurface(descriptor.seconds, true);
          break;
        case "insert-into-doc":
          void stageDocInsertFromEmbed({
            mediaType: descriptor.mediaType,
            itemId: descriptor.itemId,
            title: descriptor.altTitle,
          });
          break;
      }
    },
    [applyDraftPatchToWorkspace, navigateInStudio, stageDocInsertFromEmbed],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      chatOpen,
      rightMode,
      openChat,
      closeChat,
      toggleChat,
      setRightMode,
      registerShellAdapter,
      composerFocusSeq,
      requestComposerFocus,
      threads,
      threadsLoading,
      activeThreadId,
      activeThreadTitle,
      messages,
      streaming,
      streamingText,
      streamingThoughtHeadline,
      streamingThoughtSteps,
      streamingThoughtDurationMs,
      streamingToolLabel,
      streamingParts,
      errorMessage,
      ambientMuted,
      setAmbientMuted,
      chatModel,
      chatEffort,
      setChatModel,
      setChatEffort,
      pendingSlashCommand,
      setPendingSlashCommand,
      startNewThread,
      selectThread,
      deleteThread,
      sendMessage,
      cancelStream,
      confirmCardAction,
      runCardClientAction,
      stageDocInsertFromEmbed,
    }),
    [
      chatOpen,
      rightMode,
      openChat,
      closeChat,
      toggleChat,
      setRightMode,
      registerShellAdapter,
      composerFocusSeq,
      requestComposerFocus,
      threads,
      threadsLoading,
      activeThreadId,
      activeThreadTitle,
      messages,
      streaming,
      streamingText,
      streamingThoughtHeadline,
      streamingThoughtSteps,
      streamingThoughtDurationMs,
      streamingToolLabel,
      streamingParts,
      errorMessage,
      ambientMuted,
      chatModel,
      chatEffort,
      setChatModel,
      setChatEffort,
      pendingSlashCommand,
      startNewThread,
      selectThread,
      deleteThread,
      sendMessage,
      cancelStream,
      confirmCardAction,
      runCardClientAction,
      stageDocInsertFromEmbed,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChat must be used inside ChatProvider");
  }
  return ctx;
}

export function useOptionalChat(): ChatContextValue | null {
  return useContext(ChatContext);
}
