"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  PanelRightClose,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import type { HeaderActions } from "@/components/shell/header-action";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  seekActiveChatSurface,
  useActiveChatViewContext,
} from "@/lib/chat-context-bridge";
import { tokenizeUserTextWithReferences } from "@/lib/chat/references";
import {
  orderChatResultParts,
  type ActiveViewContext,
  type ChatResultPart,
  type SlashCommandId,
} from "@/lib/chat/types";
import { ChatActionCard } from "./chat-action-card";
import { ChatReferenceChip } from "./chat-reference-chip";
import { ChatComposer } from "./chat-composer";
import {
  ChatMarkdown,
  parseChatMediaLink,
  type ChatMarkdownProps,
} from "./chat-markdown";
import { ChatMediaEmbed } from "./chat-media-embed";
import { useChat } from "./chat-provider";
import { ChatThoughtDisclosure } from "./chat-thought-disclosure";
import { useChatMessageNarration } from "./use-chat-message-narration";

export interface ChatPanelProps {
  onToggleDock?: () => void;
  hasInspector?: boolean;
}

interface StarterSuggestion {
  label: string;
  prompt?: string;
  slashCommand?: SlashCommandId;
}

function buildStarterSuggestions(
  activeView: ActiveViewContext | null,
): StarterSuggestion[] {
  switch (activeView?.surface) {
    case "analysis":
    case "video":
      return [
        {
          label: "Summarize key moments with timestamps",
          prompt: "Summarize the key moments with clickable timestamps.",
        },
        { label: "/analyze", slashCommand: "analyze" },
        { label: "/narrate", slashCommand: "narrate" },
      ];
    case "tree-doc":
      return [
        {
          label: "Summarize this document",
          prompt: "Summarize this document concisely.",
        },
        { label: "/image", slashCommand: "image" },
        { label: "/narrate", slashCommand: "narrate" },
      ];
    case "narration":
      return [
        {
          label: "Extract key takeaways",
          prompt: "Extract the key takeaways from this narration.",
        },
        { label: "/doc", slashCommand: "doc" },
      ];
    default:
      return [
        { label: "/find", slashCommand: "find" },
        { label: "/image", slashCommand: "image" },
        { label: "/analyze", slashCommand: "analyze" },
      ];
  }
}

function formatRelativeTime(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return "now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function ResultPartList({
  parts,
  onOpenRoute,
  onSeekTimestamp,
}: {
  parts: readonly ChatResultPart[];
  onOpenRoute: (href: string) => void;
  onSeekTimestamp: (seconds: number) => void;
}): React.JSX.Element | null {
  if (parts.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {parts.map((part, idx) => {
        if (part.kind === "media-embed") {
          return (
            <ChatMediaEmbed
              key={`embed_${part.itemId}_${idx}`}
              mediaType={part.mediaType}
              itemId={part.itemId}
              generationId={part.generationId}
              title={part.title}
              subtitle={part.subtitle}
              excerptMarkdown={part.excerptMarkdown}
              clipStartSeconds={part.clipStartSeconds}
              onOpenRoute={onOpenRoute}
              onSeekTimestamp={onSeekTimestamp}
            />
          );
        }
        if (part.kind === "action-card") {
          return <ChatActionCard key={`card_${part.callId}`} part={part} />;
        }
        return (
          <div
            key={`links_${idx}`}
            className="flex flex-wrap items-center gap-1.5"
          >
            {part.items.map((item, itemIdx) => {
              if (item.kind === "timestamp" && typeof item.seconds === "number") {
                return (
                  <button
                    key={`${item.label}_${itemIdx}`}
                    type="button"
                    data-seek-seconds={item.seconds}
                    onClick={() => onSeekTimestamp(item.seconds!)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-[var(--surface-inset)] px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-[var(--surface-subtle)]"
                  >
                    <Clock size={11} className="shrink-0 text-ink-muted" />
                    <span>{item.label}</span>
                  </button>
                );
              }
              const parsedMedia = parseChatMediaLink(item.href);
              const resolvedHref = parsedMedia ? parsedMedia.href : item.href;
              return (
                <button
                  key={`${item.href}_${itemIdx}`}
                  type="button"
                  data-route-href={resolvedHref}
                  onClick={() => onOpenRoute(resolvedHref)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-[var(--surface-inset)] px-2 py-1 text-xs text-foreground transition-colors hover:bg-[var(--surface-subtle)]"
                >
                  <FileText size={11} className="shrink-0 text-ink-muted" />
                  <span className="max-w-[200px] truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const ACTION_ICON_LEFT_INSET_PX = 6;

function AssistantMessageTextBlock({
  messageId,
  text,
  isCopied,
  isNarrating,
  narration,
  onCopy,
  onToggleNarrate,
  onOpenRoute,
  onSeekTimestamp,
}: {
  messageId: string;
  text: string;
  isCopied: boolean;
  isNarrating: boolean;
  narration: ChatMarkdownProps["narration"];
  onCopy: (messageId: string, text: string) => void;
  onToggleNarrate: (messageId: string, text: string) => void;
  onOpenRoute: (href: string) => void;
  onSeekTimestamp: (seconds: number) => void;
}): React.JSX.Element {
  const markdownWrapRef = useRef<HTMLDivElement | null>(null);
  const [actionOffsetPx, setActionOffsetPx] = useState<number>(
    -ACTION_ICON_LEFT_INSET_PX,
  );

  const measureTextLeftEdge = useCallback(() => {
    const wrap = markdownWrapRef.current;
    if (!wrap) return;
    const edges = wrap.querySelectorAll<HTMLElement>("[data-chat-block-edge]");
    const lastEdge = edges.length > 0 ? edges[edges.length - 1] : null;
    const textIndentPx = lastEdge
      ? Math.max(
          0,
          lastEdge.getBoundingClientRect().left -
            wrap.getBoundingClientRect().left,
        )
      : 0;
    const nextOffset =
      Math.round((textIndentPx - ACTION_ICON_LEFT_INSET_PX) * 2) / 2;
    setActionOffsetPx((prev) => (prev === nextOffset ? prev : nextOffset));
  }, []);

  useLayoutEffect(() => {
    measureTextLeftEdge();
  }, [measureTextLeftEdge, text]);

  useEffect(() => {
    const wrap = markdownWrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measureTextLeftEdge();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [measureTextLeftEdge]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div ref={markdownWrapRef} className="min-w-0">
        <ChatMarkdown
          markdown={text}
          onOpenRoute={onOpenRoute}
          onSeekTimestamp={onSeekTimestamp}
          narration={narration}
        />
      </div>
      <div
        data-chat-actions=""
        style={{ transform: `translateX(${actionOffsetPx}px)` }}
        className="flex w-fit items-center gap-1"
      >
        <button
          type="button"
          data-chat-action="copy"
          aria-label={isCopied ? "Copied message" : "Copy message"}
          title={isCopied ? "Copied" : "Copy message"}
          onClick={() => onCopy(messageId, text)}
          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[var(--surface-inset)] hover:text-foreground"
        >
          {isCopied ? (
            <Check size={13} className="text-foreground" />
          ) : (
            <Copy size={13} />
          )}
        </button>
        <button
          type="button"
          data-chat-action="narrate"
          aria-label={isNarrating ? "Pause narration" : "Narrate message"}
          aria-pressed={isNarrating}
          title={isNarrating ? "Pause narration" : "Play narration"}
          onClick={() => onToggleNarrate(messageId, text)}
          className={cn(
            "inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-inset)] hover:text-foreground",
            isNarrating ? "text-foreground" : "text-ink-muted",
          )}
        >
          {isNarrating ? <Pause size={13} /> : <Play size={13} />}
        </button>
      </div>
    </div>
  );
}

export function visibleStreamingResultParts(
  streamingParts: readonly ChatResultPart[],
  streamingText: string,
): ChatResultPart[] {
  if (!streamingText.trim()) return [];
  return streamingParts.filter((part) => part.kind === "action-card");
}

export function ChatPanel({
  onToggleDock,
  hasInspector = false,
}: ChatPanelProps): React.JSX.Element {
  const chat = useChat();
  const workspace = useOptionalWorkspace();
  const activeView = useActiveChatViewContext();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageNarration = useChatMessageNarration(chat.activeThreadId);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyMessage = useCallback((messageId: string, text: string) => {
    if (!text) return;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
    setCopiedMessageId(messageId);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(() => {
      setCopiedMessageId((prev) => (prev === messageId ? null : prev));
    }, 1500);
  }, []);

  const handleOpenRoute = useCallback(
    (href: string) => {
      if (!href) return;
      if (workspace) {
        const tab = workspace.store.visit(href);
        if (tab) {
          workspace.openView(tab);
          return;
        }
      }
      if (typeof window !== "undefined") {
        window.location.assign(href);
      }
    },
    [workspace],
  );

  const handleSeekTimestamp = useCallback((seconds: number) => {
    seekActiveChatSurface(seconds, true);
  }, []);

  // Keep viewport anchored near bottom when new messages or stream chunks arrive.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    chat.messages,
    chat.streaming,
    chat.streamingText,
    chat.streamingThoughtHeadline,
    chat.streamingToolLabel,
    chat.streamingParts,
  ]);

  const recentThreads = useMemo(() => chat.threads.slice(0, 15), [chat.threads]);
  const starterSuggestions = useMemo(
    () => buildStarterSuggestions(activeView),
    [activeView],
  );

  const headerActions: HeaderActions = useMemo(
    () => [
      {
        icon: Plus,
        label: "New chat",
        onClick: chat.startNewThread,
      },
      hasInspector
        ? {
            icon: SlidersHorizontal,
            label: "Switch to inspector",
            onClick: () => chat.setRightMode("inspector"),
          }
        : {
            icon: PanelRightClose,
            label: "Close chat (⌘J)",
            onClick: () => (onToggleDock ? onToggleDock() : chat.closeChat()),
          },
    ],
    [chat, hasInspector, onToggleDock],
  );

  const threadSwitcherTitleNode = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch chat thread"
          className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted"
        >
          <span className="truncate">{chat.activeThreadTitle || "Chat"}</span>
          <ChevronDown size={13} className="shrink-0 text-ink-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => chat.startNewThread()}>
          <Plus size={14} />
          <span>New chat</span>
        </DropdownMenuItem>
        {hasInspector && onToggleDock ? (
          <DropdownMenuItem onSelect={() => onToggleDock()}>
            <PanelRightClose size={14} />
            <span>Dock panel</span>
          </DropdownMenuItem>
        ) : null}
        {recentThreads.length > 0 ? <DropdownMenuSeparator /> : null}
        {recentThreads.map((thread) => (
          <DropdownMenuItem
            key={thread.id}
            onSelect={() => void chat.selectThread(thread.id)}
            className="flex items-center justify-between gap-2"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                thread.id === chat.activeThreadId && "font-semibold",
              )}
            >
              {thread.title || "Untitled chat"}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="t-mono text-[11px] text-ink-faint">
                {formatRelativeTime(thread.updatedAt)}
              </span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Delete ${thread.title || "chat"}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void chat.deleteThread(thread.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    void chat.deleteThread(thread.id);
                  }
                }}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={12} />
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const isEmptyState = chat.messages.length === 0 && !chat.streaming;

  return (
    <WorkbenchPanel
      title={chat.activeThreadTitle || "Chat"}
      titleNode={threadSwitcherTitleNode}
      actions={headerActions}
      bodyClassName="overflow-hidden bg-[var(--surface-page)]"
      className="bg-[var(--surface-page)]"
    >
      <div className="flex h-full min-h-0 flex-col bg-[var(--surface-page)]">
        <div
          ref={scrollContainerRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const distanceFromBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight;
            stickToBottomRef.current = distanceFromBottom < 56;
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
        >
          {isEmptyState ? (
            <div className="flex flex-1 flex-col justify-center gap-3 py-6">
              <div className="flex flex-col gap-1">
                <p className="text-[13.5px] font-medium text-foreground">
                  Contextual Studio assistant
                </p>
                <p className="t-meta text-ink-muted">
                  Ask about the open item, search your Library, or stage media and document edits with slash commands.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {starterSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => {
                      if (suggestion.prompt) {
                        void chat.sendMessage({ text: suggestion.prompt });
                      } else if (suggestion.slashCommand) {
                        chat.setPendingSlashCommand(suggestion.slashCommand);
                        chat.requestComposerFocus();
                      }
                    }}
                    className={cn(
                      "inline-flex h-7 cursor-pointer items-center rounded-lg border border-border bg-[var(--surface-inset)] px-2.5 text-xs text-foreground transition-colors hover:bg-[var(--surface-subtle)]",
                      suggestion.slashCommand && "t-mono",
                    )}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {chat.messages.map((message) => {
            if (message.role === "user") {
              const tokenizedUser = tokenizeUserTextWithReferences(
                message.text,
                message.references,
              );
              return (
                <div
                  key={message.id}
                  className="flex flex-col items-end gap-1"
                >
                  {message.contextBadge ? (
                    message.contextBadge.href ? (
                      <button
                        type="button"
                        onClick={() => handleOpenRoute(message.contextBadge!.href!)}
                        className="t-meta max-w-full cursor-pointer truncate text-ink-faint transition-colors hover:text-ink-muted"
                      >
                        {message.contextBadge.label}
                      </button>
                    ) : (
                      <span className="t-meta max-w-full truncate text-ink-faint">
                        {message.contextBadge.label}
                      </span>
                    )
                  ) : null}

                  <div className="flex max-w-[88%] flex-col gap-1.5 rounded-2xl bg-[var(--surface-inset)] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-foreground">
                    {tokenizedUser.unmatchedReferences.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {tokenizedUser.unmatchedReferences.map((ref) => (
                          <ChatReferenceChip
                            key={`${message.id}_extra_${ref.uri}`}
                            reference={ref}
                            onOpenRoute={handleOpenRoute}
                          />
                        ))}
                      </div>
                    ) : null}
                    {message.slashCommand || tokenizedUser.segments.length > 0 ? (
                      <div className="flex flex-wrap items-baseline gap-1.5 break-words">
                        {message.slashCommand ? (
                          <span className="t-mono inline-flex items-center rounded border border-border bg-[var(--surface-card)] px-1.5 py-0.5 text-xs text-foreground">
                            {`/${message.slashCommand}`}
                          </span>
                        ) : null}
                        {tokenizedUser.segments.map((seg, segIdx) =>
                          seg.kind === "reference" ? (
                            <ChatReferenceChip
                              key={`${message.id}_ref_${segIdx}_${seg.reference.uri}`}
                              reference={seg.reference}
                              onOpenRoute={handleOpenRoute}
                            />
                          ) : (
                            <span key={`${message.id}_txt_${segIdx}`}>
                              {seg.text}
                            </span>
                          ),
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }

            const hasAssistantText = Boolean(message.text.trim());
            const isCopied = copiedMessageId === message.id;
            const isNarratingThis = messageNarration.isMessagePlaying(message.id);
            const orderedParts =
              message.resultParts && message.resultParts.length > 0
                ? orderChatResultParts(message.resultParts)
                : [];

            return (
              <div
                key={message.id}
                className="flex min-w-0 flex-col gap-2.5"
              >
                {message.thoughtSummary ? (
                  <ChatThoughtDisclosure
                    streaming={false}
                    headline={null}
                    steps={message.thoughtSummary.steps}
                    durationMs={message.thoughtSummary.durationMs}
                  />
                ) : null}

                {hasAssistantText ? (
                  <AssistantMessageTextBlock
                    messageId={message.id}
                    text={message.text}
                    isCopied={isCopied}
                    isNarrating={isNarratingThis}
                    narration={messageNarration.getNarrationForMessage(
                      message.id,
                      message.text,
                    )}
                    onCopy={handleCopyMessage}
                    onToggleNarrate={messageNarration.toggleMessage}
                    onOpenRoute={handleOpenRoute}
                    onSeekTimestamp={handleSeekTimestamp}
                  />
                ) : null}

                {orderedParts.length > 0 ? (
                  <ResultPartList
                    parts={orderedParts}
                    onOpenRoute={handleOpenRoute}
                    onSeekTimestamp={handleSeekTimestamp}
                  />
                ) : null}
              </div>
            );
          })}

          {chat.streaming ? (
            <div className="flex min-w-0 flex-col gap-2.5">
              <ChatThoughtDisclosure
                streaming={true}
                headline={chat.streamingThoughtHeadline}
                steps={chat.streamingThoughtSteps}
                durationMs={chat.streamingThoughtDurationMs}
              />

              {chat.streamingToolLabel ? (
                <div className="flex h-6 min-w-0 items-center">
                  <span className="t-meta truncate text-ink-muted transition-opacity duration-150">
                    {chat.streamingToolLabel}
                  </span>
                </div>
              ) : null}

              {chat.streamingText ? (
                <ChatMarkdown
                  markdown={chat.streamingText}
                  onOpenRoute={handleOpenRoute}
                  onSeekTimestamp={handleSeekTimestamp}
                />
              ) : null}

              {(() => {
                const liveParts = visibleStreamingResultParts(
                  chat.streamingParts,
                  chat.streamingText,
                );
                return liveParts.length > 0 ? (
                  <ResultPartList
                    parts={liveParts}
                    onOpenRoute={handleOpenRoute}
                    onSeekTimestamp={handleSeekTimestamp}
                  />
                ) : null;
              })()}
            </div>
          ) : null}

          {chat.errorMessage || messageNarration.errorMessage ? (
            <p role="alert" className="t-meta rounded-lg border border-border bg-[var(--surface-inset)] px-3 py-2 text-destructive">
              {chat.errorMessage || messageNarration.errorMessage}
            </p>
          ) : null}
        </div>

        <ChatComposer />
      </div>
    </WorkbenchPanel>
  );
}
