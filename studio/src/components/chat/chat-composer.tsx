"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { ArrowUp, Check, ChevronDown, Square, X } from "lucide-react";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActiveChatViewContext } from "@/lib/chat-context-bridge";
import {
  extractActiveHashTrigger,
  formatChatEntityUri,
  referenceKindLabel,
} from "@/lib/chat/references";
import {
  extractLeadingSlashCommand,
  filterSlashCommands,
  getSlashCommand,
  type SlashCommandEntry,
} from "@/lib/chat/slash-commands";
import {
  CHAT_EFFORT_OPTIONS,
  CHAT_MODEL_OPTIONS,
  formatChatSelectorLabel,
  type ChatEntityReference,
  type ChatReferenceKind,
  type SlashCommandId,
} from "@/lib/chat/types";
import { STUDIO_MUTATION_EVENT, studioJson } from "@/lib/media-client";
import type { WorkspaceSnapshot } from "@/lib/workspace";
import { ChatAmbientPill } from "./chat-ambient-pill";
import { useChat } from "./chat-provider";
import { ChatReferenceChip } from "./chat-reference-chip";
import { ChatReferencePopover } from "./chat-reference-popover";
import { ChatSlashPopover } from "./chat-slash-popover";

const REFERENCE_CACHE_TTL_MS = 20_000;
const referenceQueryCache = new Map<
  string,
  { items: ChatEntityReference[]; fetchedAt: number }
>();

function collectLocalWorkspaceDraftReferences(
  snapshot: WorkspaceSnapshot | undefined,
  search: string,
  kindFilter: ChatReferenceKind | null,
): ChatEntityReference[] {
  if (!snapshot) return [];
  const candidates: ChatEntityReference[] = [];
  const normalized = search.trim().toLowerCase();

  for (const tab of snapshot.tabs) {
    if (!tab.href.startsWith("/studio")) continue;
    const url = new URL(tab.href, "https://workspace.local");
    const draftId = url.searchParams.get("draft") || "default";
    let kind: ChatReferenceKind = "narration";
    if (url.pathname === "/studio/video") kind = "video";
    else if (url.pathname === "/studio/image") kind = "image";
    else if (url.pathname === "/studio/music") kind = "music";
    else if (url.pathname === "/studio/analysis") kind = "analysis";

    if (kindFilter && kind !== kindFilter) continue;

    const cleanTitle =
      tab.title?.trim() || `${kind[0]!.toUpperCase()}${kind.slice(1)} draft`;
    if (
      /^draft$/i.test(cleanTitle) ||
      /^(image|video|music|analysis) draft$/i.test(cleanTitle)
    ) {
      if (!normalized.includes("draft")) continue;
    }

    if (
      normalized &&
      !`${cleanTitle} ${kind} draft`.toLowerCase().includes(normalized)
    ) {
      continue;
    }

    candidates.push({
      uri: formatChatEntityUri({ kind, id: `draft_${draftId}` }),
      kind,
      id: `draft_${draftId}`,
      title: cleanTitle,
      subtitle: "Unsaved workspace draft",
      metaLabel: "Draft",
      href: tab.href,
      isLocalDraft: true,
      updatedAt: tab.visitedAt ?? 0,
    });
  }

  return candidates.slice(0, 5);
}

function filterAndRankClientReferences(
  pool: readonly ChatEntityReference[],
  search: string,
  kindFilter: ChatReferenceKind | null,
  activeRoute: string,
): ChatEntityReference[] {
  const normalized = search.trim().toLowerCase();
  const terms = normalized ? normalized.split(/\s+/).filter(Boolean) : [];

  const scored: Array<{ item: ChatEntityReference; score: number }> = [];

  for (const item of pool) {
    if (kindFilter && item.kind !== kindFilter) continue;

    let score = 0;
    if (
      activeRoute &&
      item.href &&
      !item.href.startsWith("#") &&
      activeRoute.startsWith(item.href)
    ) {
      score += 400;
    }

    if (terms.length > 0) {
      const titleLower = item.title.toLowerCase();
      const kindLower = referenceKindLabel(
        item.kind,
        item.characterKind,
      ).toLowerCase();
      const haystack = [
        titleLower,
        item.subtitle?.toLowerCase() ?? "",
        item.id.toLowerCase(),
        item.subId?.toLowerCase() ?? "",
        kindLower,
      ].join(" ");

      if (!terms.every((t) => haystack.includes(t))) continue;

      if (titleLower === normalized) score += 260;
      else if (titleLower.startsWith(normalized)) score += 180;
      else if (titleLower.includes(normalized)) score += 110;
      else score += 45;
    }

    scored.push({ item, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0),
  );

  return scored.slice(0, 24).map((entry) => entry.item);
}

export function ChatComposer(): JSX.Element {
  const chat = useChat();
  const workspace = useOptionalWorkspace();
  const activeView = useActiveChatViewContext();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocusSeqRef = useRef(0);

  const [text, setText] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selectedSlash, setSelectedSlash] = useState<SlashCommandId | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  const [selectedReferences, setSelectedReferences] = useState<
    ChatEntityReference[]
  >([]);
  const [catalogReferences, setCatalogReferences] = useState<
    ChatEntityReference[]
  >(() => referenceQueryCache.get("limit=50")?.items ?? []);
  const [queryReferences, setQueryReferences] = useState<
    ChatEntityReference[]
  >([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [hashSelectedIndex, setHashSelectedIndex] = useState(0);
  const [dismissedHashKey, setDismissedHashKey] = useState<string | null>(null);

  // Pre-warm the Studio reference catalog when ChatComposer mounts and on Studio mutations
  // so typing `#` opens the reference list immediately without a loading flash.
  useEffect(() => {
    let cancelled = false;
    const warmKey = "limit=50";

    const loadCatalog = (force = false) => {
      const cached = referenceQueryCache.get(warmKey);
      if (
        !force &&
        cached &&
        Date.now() - cached.fetchedAt < REFERENCE_CACHE_TTL_MS
      ) {
        setCatalogReferences(cached.items);
        return;
      }
      studioJson<{ items: ChatEntityReference[] }>(
        `/api/v1/chat/references?${warmKey}`,
      )
        .then((res) => {
          if (cancelled) return;
          const items = Array.isArray(res.items) ? res.items : [];
          referenceQueryCache.set(warmKey, { items, fetchedAt: Date.now() });
          setCatalogReferences(items);
        })
        .catch(() => undefined);
    };

    loadCatalog(false);
    const onMutation = () => {
      referenceQueryCache.clear();
      loadCatalog(true);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(STUDIO_MUTATION_EVENT, onMutation);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(STUDIO_MUTATION_EVENT, onMutation);
      }
    };
  }, []);

  // Consume external initialSlashCommand requests from openChat({ initialSlashCommand }).
  useEffect(() => {
    if (!chat.pendingSlashCommand) return;
    const cmd = chat.pendingSlashCommand;
    chat.setPendingSlashCommand(null);
    if (cmd === "new") {
      chat.startNewThread();
      return;
    }
    setSelectedSlash(cmd);
    textareaRef.current?.focus();
  }, [chat]);

  // Focus composer whenever composerFocusSeq increments.
  useEffect(() => {
    if (chat.composerFocusSeq === lastFocusSeqRef.current) return;
    lastFocusSeqRef.current = chat.composerFocusSeq;
    textareaRef.current?.focus();
  }, [chat.composerFocusSeq]);

  // Auto-grow textarea up to 160px.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const rawSlashQuery = useMemo(() => {
    if (selectedSlash !== null) return null;
    if (!text.startsWith("/")) return null;
    const afterSlash = text.slice(1);
    if (/\s/.test(afterSlash)) return null;
    return afterSlash;
  }, [selectedSlash, text]);

  const filteredCommands = useMemo(() => {
    if (rawSlashQuery === null) return [];
    return filterSlashCommands(rawSlashQuery);
  }, [rawSlashQuery]);

  const slashPopoverOpen =
    rawSlashQuery !== null &&
    dismissedQuery !== text &&
    filteredCommands.length > 0;

  const safeSelectedIndex =
    filteredCommands.length > 0
      ? Math.min(selectedIndex, filteredCommands.length - 1)
      : 0;

  const selectedReferenceUris = useMemo(
    () => new Set(selectedReferences.map((ref) => ref.uri)),
    [selectedReferences],
  );

  const activeHashTrigger = useMemo(
    () => extractActiveHashTrigger(text, cursorOffset, []),
    [cursorOffset, text],
  );

  const currentHashKey = activeHashTrigger
    ? `${activeHashTrigger.startOffset}:${activeHashTrigger.rawQuery}`
    : null;

  const hashPopoverOpen =
    !slashPopoverOpen &&
    activeHashTrigger !== null &&
    dismissedHashKey !== currentHashKey;

  const activeRoute = activeView?.route ?? "";
  const hashSearch = activeHashTrigger?.search ?? "";
  const hashKindFilter = activeHashTrigger?.kindFilter ?? null;

  // Fetch deep server matches when `#` is active (especially for specific `#kind:` filters or search queries).
  useEffect(() => {
    if (!hashPopoverOpen) {
      setQueryReferences([]);
      setReferencesLoading(false);
      return;
    }

    // Bare `#` is already satisfied by the pre-warmed 50-item catalog once loaded.
    if (!hashSearch && !hashKindFilter && catalogReferences.length > 0) {
      setQueryReferences([]);
      setReferencesLoading(false);
      return;
    }

    const params = new URLSearchParams();
    if (hashSearch) {
      params.set("q", hashSearch);
    }
    if (hashKindFilter) {
      params.set("kind", hashKindFilter);
    }
    if (activeRoute) {
      params.set("activeRoute", activeRoute);
    }
    params.set("limit", "30");

    const cacheKey = params.toString();
    const cached = referenceQueryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < REFERENCE_CACHE_TTL_MS) {
      setQueryReferences(cached.items);
      setReferencesLoading(false);
      return;
    }

    const controller = new AbortController();
    setReferencesLoading(true);

    const delayMs = hashSearch.length > 0 ? 60 : 0;
    const timer = setTimeout(() => {
      studioJson<{ items: ChatEntityReference[] }>(
        `/api/v1/chat/references?${cacheKey}`,
        { signal: controller.signal },
      )
        .then((res) => {
          if (controller.signal.aborted) return;
          const items = Array.isArray(res.items) ? res.items : [];
          referenceQueryCache.set(cacheKey, {
            items,
            fetchedAt: Date.now(),
          });
          setQueryReferences(items);
          setReferencesLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setReferencesLoading(false);
        });
    }, delayMs);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    activeRoute,
    catalogReferences.length,
    hashKindFilter,
    hashPopoverOpen,
    hashSearch,
  ]);

  const combinedReferences = useMemo(() => {
    if (!hashPopoverOpen || !activeHashTrigger) return [];

    const mergedPoolMap = new Map<string, ChatEntityReference>();
    for (const item of queryReferences) {
      if (!selectedReferenceUris.has(item.uri)) {
        mergedPoolMap.set(item.uri, item);
      }
    }
    for (const item of catalogReferences) {
      if (
        !selectedReferenceUris.has(item.uri) &&
        !mergedPoolMap.has(item.uri)
      ) {
        mergedPoolMap.set(item.uri, item);
      }
    }

    const localDrafts = collectLocalWorkspaceDraftReferences(
      workspace?.state,
      activeHashTrigger.search,
      activeHashTrigger.kindFilter,
    );
    for (const draft of localDrafts) {
      if (
        !selectedReferenceUris.has(draft.uri) &&
        !mergedPoolMap.has(draft.uri)
      ) {
        mergedPoolMap.set(draft.uri, draft);
      }
    }

    return filterAndRankClientReferences(
      Array.from(mergedPoolMap.values()),
      activeHashTrigger.search,
      activeHashTrigger.kindFilter,
      activeRoute,
    );
  }, [
    activeHashTrigger,
    activeRoute,
    catalogReferences,
    hashPopoverOpen,
    queryReferences,
    selectedReferenceUris,
    workspace?.state,
  ]);

  const safeHashIndex =
    combinedReferences.length > 0
      ? Math.min(hashSelectedIndex, combinedReferences.length - 1)
      : 0;

  const handleSelectSlashEntry = useCallback(
    (entry: SlashCommandEntry) => {
      if (entry.command === "new") {
        setText("");
        setCursorOffset(0);
        setSelectedSlash(null);
        setSelectedReferences([]);
        setDismissedQuery(null);
        chat.startNewThread();
        return;
      }
      setSelectedSlash(entry.command);
      setText("");
      setCursorOffset(0);
      setSelectedIndex(0);
      setDismissedQuery(null);
      textareaRef.current?.focus();
    },
    [chat],
  );

  const handleSelectReference = useCallback(
    (ref: ChatEntityReference) => {
      if (!activeHashTrigger) return;
      const before = text.slice(0, activeHashTrigger.startOffset);
      const after = text.slice(activeHashTrigger.endOffset);
      let nextText: string;
      let nextCursor: number;

      if (before.length === 0) {
        nextText = after.replace(/^\s+/, "");
        nextCursor = 0;
      } else if (before.endsWith(" ") && after.startsWith(" ")) {
        nextText = `${before}${after.slice(1)}`;
        nextCursor = before.length;
      } else {
        nextText = `${before}${after}`;
        nextCursor = before.length;
      }

      setText(nextText);
      setCursorOffset(nextCursor);
      setHashSelectedIndex(0);
      setDismissedHashKey(null);
      setSelectedReferences((prev) => {
        if (prev.some((item) => item.uri === ref.uri)) return prev;
        return [...prev, ref];
      });

      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeHashTrigger, text],
  );

  const handleRemoveReference = useCallback((uri: string) => {
    setSelectedReferences((prev) => prev.filter((item) => item.uri !== uri));
    textareaRef.current?.focus();
  }, []);

  const handleOpenReferenceRoute = useCallback(
    (href: string) => {
      chat.runCardClientAction({
        kind: "open-route",
        label: "Open",
        href,
      });
    },
    [chat],
  );

  const canSubmit =
    !chat.streaming &&
    (text.trim().length > 0 ||
      selectedSlash !== null ||
      selectedReferences.length > 0);

  const handleSubmit = useCallback(async () => {
    if (chat.streaming) return;

    let effectiveSlash = selectedSlash;
    let effectiveText = text.trim();

    if (!effectiveSlash && effectiveText.startsWith("/")) {
      const extracted = extractLeadingSlashCommand(effectiveText);
      if (extracted.slashCommand) {
        effectiveSlash = extracted.slashCommand.command;
        effectiveText = extracted.remainingText;
      }
    }

    if (effectiveSlash === "new") {
      setText("");
      setCursorOffset(0);
      setSelectedSlash(null);
      setSelectedReferences([]);
      chat.startNewThread();
      return;
    }

    if (
      !effectiveText &&
      !effectiveSlash &&
      selectedReferences.length === 0
    ) {
      return;
    }

    const refsToSend =
      selectedReferences.length > 0 ? [...selectedReferences] : undefined;

    setText("");
    setCursorOffset(0);
    setSelectedSlash(null);
    setSelectedReferences([]);
    setDismissedQuery(null);
    setDismissedHashKey(null);
    setSelectedIndex(0);
    setHashSelectedIndex(0);

    await chat.sendMessage({
      text: effectiveText,
      slashCommand: effectiveSlash,
      ...(refsToSend ? { references: refsToSend } : {}),
    });
  }, [chat, selectedReferences, selectedSlash, text]);

  const activeSlashSpec = getSlashCommand(selectedSlash);
  const placeholder = activeSlashSpec
    ? activeSlashSpec.argumentHint
    : "Ask about this view, # to reference, or / for actions…";
  const activeEffortOption =
    CHAT_EFFORT_OPTIONS.find((opt) => opt.value === chat.chatEffort) ??
    CHAT_EFFORT_OPTIONS[0];

  const hasHeaderChips =
    selectedSlash !== null || selectedReferences.length > 0;

  return (
    <div className="relative flex flex-col gap-2 border-t border-border px-3 py-2.5">
      {slashPopoverOpen ? (
        <ChatSlashPopover
          commands={filteredCommands}
          selectedIndex={safeSelectedIndex}
          onHoverIndex={setSelectedIndex}
          onSelect={handleSelectSlashEntry}
        />
      ) : hashPopoverOpen && activeHashTrigger ? (
        <ChatReferencePopover
          items={combinedReferences}
          loading={referencesLoading && catalogReferences.length === 0}
          kindFilter={activeHashTrigger.kindFilter}
          selectedIndex={safeHashIndex}
          onHoverIndex={setHashSelectedIndex}
          onSelect={handleSelectReference}
        />
      ) : null}

      <ChatAmbientPill />

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-[var(--surface-card)] px-3 py-2 transition-colors focus-within:border-border-strong">
        {hasHeaderChips ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedSlash ? (
              <span className="t-mono inline-flex h-6 items-center gap-1 rounded-md border border-border bg-[var(--surface-inset)] px-2 text-xs text-foreground">
                <span>{`/${selectedSlash}`}</span>
                <button
                  type="button"
                  aria-label={`Remove /${selectedSlash} command`}
                  onClick={() => {
                    setSelectedSlash(null);
                    textareaRef.current?.focus();
                  }}
                  className="inline-flex size-4 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-foreground"
                >
                  <X size={11} />
                </button>
              </span>
            ) : null}

            {selectedReferences.map((ref) => (
              <ChatReferenceChip
                key={ref.uri}
                reference={ref}
                onOpenRoute={handleOpenReferenceRoute}
                onRemove={() => handleRemoveReference(ref.uri)}
              />
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Chat message"
          onChange={(event) => {
            const nextValue = event.target.value;
            const nextPos =
              event.target.selectionStart ?? nextValue.length;
            setText(nextValue);
            setCursorOffset(nextPos);
            setSelectedIndex(0);
            setHashSelectedIndex(0);
            if (dismissedQuery && dismissedQuery !== nextValue) {
              setDismissedQuery(null);
            }
            if (dismissedHashKey) {
              setDismissedHashKey(null);
            }
          }}
          onSelect={(event) => {
            setCursorOffset(event.currentTarget.selectionStart ?? 0);
          }}
          onClick={(event) => {
            setCursorOffset(event.currentTarget.selectionStart ?? 0);
          }}
          onKeyUp={(event) => {
            if (
              event.key === "ArrowLeft" ||
              event.key === "ArrowRight" ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              setCursorOffset(event.currentTarget.selectionStart ?? 0);
            }
          }}
          onKeyDown={(event) => {
            if (slashPopoverOpen && filteredCommands.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex(
                  (prev) => (prev + 1) % filteredCommands.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex(
                  (prev) =>
                    (prev - 1 + filteredCommands.length) %
                    filteredCommands.length,
                );
                return;
              }
              if (
                event.key === "Tab" ||
                (event.key === "Enter" && !event.shiftKey)
              ) {
                event.preventDefault();
                const chosen = filteredCommands[safeSelectedIndex];
                if (chosen) handleSelectSlashEntry(chosen);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedQuery(text);
                return;
              }
            }

            if (hashPopoverOpen) {
              if (
                event.key === "ArrowDown" &&
                combinedReferences.length > 0
              ) {
                event.preventDefault();
                setHashSelectedIndex(
                  (prev) => (prev + 1) % combinedReferences.length,
                );
                return;
              }
              if (
                event.key === "ArrowUp" &&
                combinedReferences.length > 0
              ) {
                event.preventDefault();
                setHashSelectedIndex(
                  (prev) =>
                    (prev - 1 + combinedReferences.length) %
                    combinedReferences.length,
                );
                return;
              }
              if (
                event.key === "Tab" ||
                (event.key === "Enter" && !event.shiftKey)
              ) {
                event.preventDefault();
                if (combinedReferences.length > 0) {
                  const chosen = combinedReferences[safeHashIndex];
                  if (chosen) handleSelectReference(chosen);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedHashKey(currentHashKey);
                return;
              }
            }

            if (
              event.key === "Backspace" &&
              selectedSlash !== null &&
              event.currentTarget.selectionStart === 0 &&
              event.currentTarget.selectionEnd === 0
            ) {
              event.preventDefault();
              setSelectedSlash(null);
              return;
            }

            if (event.key === "Escape" && chat.streaming) {
              event.preventDefault();
              chat.cancelStream();
              return;
            }

            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          className="max-h-40 min-h-[24px] w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground placeholder:text-ink-faint outline-hidden"
        />

        <div className="flex items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Chat model and reasoning effort"
                className="t-mono inline-flex h-6 max-w-[240px] cursor-pointer items-center gap-1 rounded-md px-2 text-[11.5px] text-ink-muted transition-colors hover:bg-[var(--surface-inset)] hover:text-foreground"
              >
                <span className="truncate">
                  {formatChatSelectorLabel(chat.chatModel, chat.chatEffort)}
                </span>
                <ChevronDown size={11} className="shrink-0 opacity-70" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              side="top"
              sideOffset={8}
              className="w-72 rounded-xl border border-border bg-[var(--surface-card)] p-1.5 shadow-md"
            >
              <div className="px-2 py-1 text-[11px] font-medium text-ink-faint">
                Model
              </div>
              {CHAT_MODEL_OPTIONS.map((opt) => {
                const selected = chat.chatModel === opt.value;
                return (
                  <DropdownMenuItem
                    key={opt.value}
                    onSelect={() => chat.setChatModel(opt.value)}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="t-mono truncate text-xs text-foreground">
                        {opt.label}
                      </span>
                      <span className="t-meta text-[11px] leading-snug text-ink-muted">
                        {opt.hint}
                      </span>
                    </div>
                    {selected ? (
                      <Check
                        size={13}
                        className="size-3.5 shrink-0 text-foreground"
                      />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}

              <div className="py-1">
                <div className="h-px bg-border" />
              </div>

              <div className="flex flex-col gap-1.5 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-faint">
                    Effort
                  </span>
                  <span className="t-meta text-[11px] text-ink-muted">
                    {activeEffortOption.label}
                  </span>
                </div>
                <div
                  role="group"
                  aria-label="Reasoning effort"
                  className="grid grid-cols-5 gap-1 rounded-lg bg-[var(--surface-inset)] p-1"
                >
                  {CHAT_EFFORT_OPTIONS.map((opt) => {
                    const selected = chat.chatEffort === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={selected}
                        title={`${opt.label} — ${opt.hint}`}
                        onClick={() => chat.setChatEffort(opt.value)}
                        className={`cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
                          selected
                            ? "bg-[var(--surface-card)] text-foreground shadow-xs"
                            : "text-ink-muted hover:text-foreground"
                        }`}
                      >
                        {opt.shortLabel}
                      </button>
                    );
                  })}
                </div>
                <p className="t-meta text-[11px] leading-snug text-ink-muted">
                  {activeEffortOption.hint}
                </p>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {chat.streaming ? (
            <button
              type="button"
              aria-label="Stop response"
              onClick={chat.cancelStream}
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
            >
              <Square size={11} className="fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send message"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
            >
              <ArrowUp size={14} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
