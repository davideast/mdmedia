"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import {
  AudioLines,
  FilePlus2,
  FileText,
  Film,
  ImageIcon,
  Music,
  ScanSearch,
} from "lucide-react";
import { cn } from "cn";
import { useActiveImageCount } from "@/components/media/media-activity-provider";
import { useActiveChatViewContext } from "@/lib/chat-context-bridge";
import type {
  ActionCardRevisionTarget,
  ActionCardState,
  CardActionDescriptor,
  ChatResultPart,
  StagedMediaDeliveryMode,
  StoredChatMessage,
} from "@/lib/chat/types";
import { STUDIO_MUTATION_EVENT, studioJson } from "@/lib/media-client";
import type { GenerationResource } from "@/lib/media-types";
import { mediaRouteForItem } from "./chat-markdown";
import { ChatMediaEmbed } from "./chat-media-embed";
import { useOptionalChat } from "./chat-provider";

export type ChatActionCardPart = Extract<ChatResultPart, { kind: "action-card" }>;

export interface ChatActionCardProps {
  part: ChatActionCardPart;
}

function phasePercent(phase: string, status: string): number {
  if (status === "ready") return 100;
  switch (phase) {
    case "queued":
      return 14;
    case "starting":
      return 24;
    case "preparing":
      return 38;
    case "generating":
      return 64;
    case "downloading":
      return 84;
    case "saving":
    case "assembling":
      return 92;
    default:
      return status === "queued" ? 14 : 52;
  }
}

function phaseReadableLabel(phase: string): string {
  switch (phase) {
    case "queued":
      return "Waiting in queue…";
    case "starting":
      return "Starting…";
    case "preparing":
      return "Preparing inputs…";
    case "generating":
      return "Generating in Studio…";
    case "downloading":
      return "Fetching output…";
    case "saving":
    case "assembling":
      return "Saving to Library…";
    default:
      return "";
  }
}

function CardModalityIcon({
  mediaType,
  toolName,
}: {
  mediaType?: ChatActionCardPart["mediaType"];
  toolName: string;
}): JSX.Element {
  const iconClass = "shrink-0 text-ink-muted";
  if (mediaType === "analysis" || toolName.includes("analyze")) {
    return <ScanSearch size={14} className={iconClass} />;
  }
  if (mediaType === "narration" || toolName.includes("narration")) {
    return <AudioLines size={14} className={iconClass} />;
  }
  if (mediaType === "image" || toolName.includes("image")) {
    return <ImageIcon size={14} className={iconClass} />;
  }
  if (mediaType === "video" || toolName.includes("video")) {
    return <Film size={14} className={iconClass} />;
  }
  if (mediaType === "music" || toolName.includes("music")) {
    return <Music size={14} className={iconClass} />;
  }
  return <FileText size={14} className={iconClass} />;
}

function formatStateBadge(
  state: ActionCardState,
  progressPercent: number | null,
  isDocAction: boolean,
): string {
  switch (state) {
    case "staged":
      return "Draft";
    case "queued":
      return "Queued";
    case "running":
      return typeof progressPercent === "number" && progressPercent > 0
        ? `Running ${Math.round(progressPercent)}%`
        : "Running";
    case "succeeded":
      return isDocAction ? "Applied" : "Ready";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

function supportedModesForMediaType(
  mediaType: ChatActionCardPart["mediaType"],
): readonly StagedMediaDeliveryMode[] | null {
  switch (mediaType) {
    case "image":
    case "video":
      return ["refine", "regenerate", "new_item"];
    case "music":
    case "analysis":
      return ["regenerate", "new_item"];
    default:
      return null;
  }
}

function findThreadFallbackTarget(
  messages: readonly StoredChatMessage[],
  mediaType: ChatActionCardPart["mediaType"],
  currentCallId: string,
): ActionCardRevisionTarget | null {
  const supportedModes = supportedModesForMediaType(mediaType);
  if (!mediaType || !supportedModes) return null;

  type FallbackCandidate = {
    itemId: string;
    title: string;
    fromGenerationId: string | null;
  };
  let candidate = null as FallbackCandidate | null;

  outer: for (const msg of messages) {
    if (!msg.resultParts) continue;
    for (const item of msg.resultParts) {
      if (item.kind === "action-card" && item.callId === currentCallId) {
        break outer;
      }
      if (
        item.kind === "action-card" &&
        item.mediaType === mediaType &&
        item.itemId &&
        item.state !== "staged" &&
        item.state !== "canceled" &&
        item.state !== "failed"
      ) {
        candidate = {
          itemId: item.itemId,
          title: item.title,
          fromGenerationId: item.generationId ?? null,
        };
      } else if (item.kind === "media-embed" && item.mediaType === mediaType && item.itemId) {
        candidate = {
          itemId: item.itemId,
          title: item.title,
          fromGenerationId: item.generationId ?? candidate?.fromGenerationId ?? null,
        };
      }
    }
  }

  if (!candidate) return null;
  return {
    itemId: candidate.itemId,
    title: candidate.title,
    fromGenerationId: candidate.fromGenerationId,
    defaultMode: "new_item",
    supportedModes,
  };
}

function modeOptionLabel(
  mediaType: ChatActionCardPart["mediaType"],
  mode: StagedMediaDeliveryMode,
): string {
  switch (mode) {
    case "refine":
      return mediaType === "video" ? "Extend clip" : "Revision";
    case "regenerate":
      return "New version";
    case "new_item":
      switch (mediaType) {
        case "image":
          return "New image";
        case "video":
          return "New video";
        case "music":
          return "New track";
        case "analysis":
          return "New analysis";
        default:
          return "New item";
      }
  }
}

function confirmLabelForMode(
  mediaType: ChatActionCardPart["mediaType"],
  mode: StagedMediaDeliveryMode,
  fallback: string,
): string {
  switch (mode) {
    case "refine":
      return mediaType === "video" ? "Extend video" : "Generate revision";
    case "regenerate":
      return mediaType === "analysis" ? "Run new version" : "Generate version";
    case "new_item":
      return mediaType === "analysis" ? "Run analysis" : fallback === "Generate revision" || fallback === "Generate version" || fallback === "Extend video" ? "Generate" : fallback;
  }
}

function formatMetaForMode(
  rawMeta: string,
  mediaType: ChatActionCardPart["mediaType"],
  mode: StagedMediaDeliveryMode,
  hasTarget: boolean,
): string {
  if (!hasTarget) return rawMeta;
  const stripped = rawMeta.replace(/^(Revision|New version|Extend clip)\s*·\s*/i, "");
  if (mode === "new_item") return stripped;
  const prefix =
    mode === "refine"
      ? mediaType === "video"
        ? "Extend clip"
        : "Revision"
      : "New version";
  return stripped ? `${prefix} · ${stripped}` : prefix;
}

export function ChatActionCard({ part }: ChatActionCardProps): JSX.Element {
  const chat = useOptionalChat();
  const activeActivityCount = useActiveImageCount();
  const activeView = useActiveChatViewContext();

  const [liveState, setLiveState] = useState<ActionCardState | null>(null);
  const [liveProgressPct, setLiveProgressPct] = useState<number | null>(null);
  const [liveProgressMsg, setLiveProgressMsg] = useState<string | null>(null);
  const [liveItemId, setLiveItemId] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [selectedModeOverride, setSelectedModeOverride] =
    useState<StagedMediaDeliveryMode | null>(null);

  useEffect(() => {
    if (part.state === "failed" || part.state === "staged") {
      setLiveState(null);
      if (part.state === "staged") {
        setLiveError(null);
      }
    }
  }, [part.state]);

  const effectiveState: ActionCardState = liveState ?? part.state;
  const effectiveItemId = liveItemId ?? part.itemId ?? null;
  const effectiveProgressPct = liveProgressPct ?? part.progressPercent ?? null;
  const effectiveProgressMsg = liveProgressMsg ?? part.progressMessage ?? null;
  const effectiveError = liveError ?? part.errorMessage ?? null;

  const effectiveRevisionTarget = useMemo<ActionCardRevisionTarget | null>(() => {
    if (part.revisionTarget) return part.revisionTarget;
    if (effectiveState !== "staged" || !part.mediaType) return null;

    const supportedModes = supportedModesForMediaType(part.mediaType);
    if (!supportedModes) return null;

    if (
      !chat?.ambientMuted &&
      activeView &&
      activeView.surface === part.mediaType &&
      "itemId" in activeView &&
      activeView.itemId
    ) {
      return {
        itemId: activeView.itemId,
        title: activeView.title || part.title,
        fromGenerationId:
          "generationId" in activeView ? (activeView.generationId ?? null) : null,
        defaultMode: "new_item",
        supportedModes,
      };
    }

    if (chat?.messages && chat.messages.length > 0) {
      return findThreadFallbackTarget(chat.messages, part.mediaType, part.callId);
    }

    return null;
  }, [
    part.revisionTarget,
    part.mediaType,
    part.title,
    part.callId,
    effectiveState,
    chat?.ambientMuted,
    chat?.messages,
    activeView,
  ]);

  const selectedMode: StagedMediaDeliveryMode =
    selectedModeOverride &&
    effectiveRevisionTarget?.supportedModes.includes(selectedModeOverride)
      ? selectedModeOverride
      : (effectiveRevisionTarget?.defaultMode ?? "new_item");

  // Subscribe to background generation state when `part.generationId` is present.
  useEffect(() => {
    const genId = part.generationId;
    if (!genId) return;
    if (
      part.state === "succeeded" ||
      part.state === "failed" ||
      part.state === "canceled"
    ) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollGeneration = async () => {
      clearTimeout(timer);
      try {
        const gen = await studioJson<GenerationResource>(
          `/api/v1/generations/${encodeURIComponent(genId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        if (gen.itemId) {
          setLiveItemId(gen.itemId);
        }

        if (gen.status === "ready") {
          setLiveState("succeeded");
          setLiveProgressPct(100);
          setLiveProgressMsg(null);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(STUDIO_MUTATION_EVENT));
          }
          return;
        }
        if (gen.status === "error" || gen.status === "interrupted") {
          setLiveState("failed");
          setLiveError(gen.error?.message ?? "Generation did not complete.");
          return;
        }

        const nextState: ActionCardState =
          gen.status === "queued" ? "queued" : "running";
        setLiveState(nextState);
        setLiveProgressPct(phasePercent(gen.phase, gen.status));

        const analysisProgress =
          "progress" in gen && typeof gen.progress === "string"
            ? gen.progress
            : null;
        setLiveProgressMsg(analysisProgress || phaseReadableLabel(gen.phase) || null);

        timer = setTimeout(() => void pollGeneration(), 2000);
      } catch {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void pollGeneration(), 4000);
        }
      }
    };

    const handleMutation = () => {
      void pollGeneration();
    };

    void pollGeneration();
    window.addEventListener(STUDIO_MUTATION_EVENT, handleMutation);

    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener(STUDIO_MUTATION_EVENT, handleMutation);
    };
  }, [part.generationId, part.state, activeActivityCount]);

  const isDocMutation =
    !part.mediaType &&
    (part.toolName.includes("tree") || part.toolName.includes("document"));
  const badgeText = formatStateBadge(
    effectiveState,
    effectiveProgressPct,
    isDocMutation,
  );

  const canRenderInlineEmbed =
    effectiveState === "succeeded" &&
    Boolean(effectiveItemId) &&
    Boolean(part.mediaType);

  const visibleActions: CardActionDescriptor[] = part.cardActions.filter((act) => {
    if (act.kind === "confirm") return effectiveState === "staged";
    if (act.kind === "edit-in-studio") return effectiveState === "staged";
    return true;
  });

  // Ensure a clean `Open` button is available for succeeded doc/route mutations without inline media embed.
  const fallbackOpenRoute =
    effectiveState === "succeeded" &&
    !canRenderInlineEmbed &&
    (part.targetRoute ||
      (effectiveItemId && part.mediaType
        ? mediaRouteForItem(part.mediaType, effectiveItemId)
        : null));

  const hasOpenActionAlready = visibleActions.some((a) => a.kind === "open-route");

  const showContextualInsertButton =
    effectiveState === "succeeded" &&
    !canRenderInlineEmbed &&
    Boolean(effectiveItemId && part.mediaType) &&
    activeView?.surface === "tree-doc" &&
    !visibleActions.some((a) => a.kind === "insert-into-doc");

  const previewText = part.previewMarkdown?.trim() ?? "";
  const isLongPreview =
    previewText.length > 160 || previewText.split("\n").length > 3;

  const progressWidth =
    typeof effectiveProgressPct === "number"
      ? Math.max(6, Math.min(100, effectiveProgressPct))
      : effectiveState === "queued"
        ? 14
        : 45;

  const displayTitle =
    effectiveState === "staged" &&
    effectiveRevisionTarget &&
    selectedMode !== "new_item"
      ? effectiveRevisionTarget.title || part.title
      : part.title;

  const displayMeta =
    effectiveState === "staged"
      ? formatMetaForMode(
          part.meta,
          part.mediaType,
          selectedMode,
          Boolean(effectiveRevisionTarget),
        )
      : part.meta;

  const handleActionClick = async (descriptor: CardActionDescriptor) => {
    if (!chat) return;
    if (descriptor.kind === "confirm") {
      if (confirmBusy) return;
      setConfirmBusy(true);
      try {
        if (effectiveRevisionTarget) {
          await chat.confirmCardAction(part.callId, {
            deliveryMode: selectedMode,
            targetItemId:
              selectedMode === "new_item" ? null : effectiveRevisionTarget.itemId,
            fromGenerationId:
              selectedMode === "refine"
                ? (effectiveRevisionTarget.fromGenerationId ?? null)
                : null,
          });
        } else {
          await chat.confirmCardAction(part.callId);
        }
      } finally {
        setConfirmBusy(false);
      }
      return;
    }
    if (descriptor.kind === "edit-in-studio" && effectiveRevisionTarget && part.mediaType) {
      const targetHref =
        selectedMode === "new_item"
          ? `/studio/${part.mediaType === "narration" ? "" : part.mediaType}`.replace(/\/$/, "")
          : mediaRouteForItem(part.mediaType, effectiveRevisionTarget.itemId);
      chat.runCardClientAction({
        ...descriptor,
        href: targetHref,
      });
      return;
    }
    chat.runCardClientAction(descriptor);
  };

  return (
    <div
      data-action-card-id={part.callId}
      data-action-state={effectiveState}
      className="flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-[var(--surface-card)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CardModalityIcon mediaType={part.mediaType} toolName={part.toolName} />
          <span className="t-card-title truncate text-[13px] font-medium text-foreground">
            {displayTitle}
          </span>
        </div>
        <span
          className={cn(
            "t-mono shrink-0 text-[11px]",
            effectiveState === "failed" ? "text-destructive" : "text-ink-faint",
          )}
        >
          {badgeText}
        </span>
      </div>

      {displayMeta ? (
        <p className="t-meta min-w-0 break-words text-ink-muted">{displayMeta}</p>
      ) : null}

      {previewText && !canRenderInlineEmbed ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="rounded-lg border border-border bg-[var(--surface-inset)] px-2.5 py-2">
            <p
              className={cn(
                "font-mono text-xs whitespace-pre-wrap text-foreground",
                !previewExpanded && "line-clamp-3",
              )}
            >
              {previewText}
            </p>
          </div>
          {isLongPreview ? (
            <button
              type="button"
              onClick={() => setPreviewExpanded((prev) => !prev)}
              className="w-fit cursor-pointer text-xs text-ink-faint transition-colors hover:text-foreground"
            >
              {previewExpanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
        </div>
      ) : null}

      {effectiveState === "staged" && effectiveRevisionTarget ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div
            role="radiogroup"
            aria-label="Generation mode"
            className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-lg border border-border bg-[var(--surface-inset)] p-0.5"
          >
            {effectiveRevisionTarget.supportedModes.map((mode) => {
              const active = selectedMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelectedModeOverride(mode)}
                  className={cn(
                    "inline-flex h-6 cursor-pointer items-center rounded-md px-2 text-xs transition-colors",
                    active
                      ? "bg-foreground font-medium text-background"
                      : "text-ink-muted hover:text-foreground",
                  )}
                >
                  {modeOptionLabel(part.mediaType, mode)}
                </button>
              );
            })}
          </div>
          <span className="t-meta truncate text-ink-faint">
            {selectedMode === "new_item"
              ? "Creates a separate item in Library"
              : `Updates ${effectiveRevisionTarget.title}`}
          </span>
        </div>
      ) : null}

      {effectiveState === "queued" || effectiveState === "running" ? (
        <div className="flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressWidth)}
            className="h-0.5 w-full overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full bg-foreground/80 transition-[width] duration-300"
              style={{ width: `${progressWidth}%` }}
            />
          </div>
          {effectiveProgressMsg ? (
            <span className="t-meta truncate text-ink-muted">
              {effectiveProgressMsg}
            </span>
          ) : null}
        </div>
      ) : null}

      {effectiveState === "failed" && effectiveError ? (
        <p role="alert" className="t-meta text-destructive">
          {effectiveError}
        </p>
      ) : null}

      {canRenderInlineEmbed && effectiveItemId && part.mediaType ? (
        <ChatMediaEmbed
          mediaType={part.mediaType}
          itemId={effectiveItemId}
          generationId={part.generationId}
          title={part.title}
          subtitle={part.meta}
        />
      ) : null}

      {visibleActions.length > 0 ||
      Boolean(fallbackOpenRoute && !hasOpenActionAlready) ||
      showContextualInsertButton ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleActions.slice(0, 3).map((descriptor, index) => {
            const isPrimary =
              descriptor.kind === "confirm" && descriptor.primary !== false;
            const label =
              descriptor.kind === "confirm" && effectiveRevisionTarget
                ? confirmLabelForMode(
                    part.mediaType,
                    selectedMode,
                    descriptor.label,
                  )
                : descriptor.label;
            return (
              <button
                key={`${descriptor.kind}_${index}`}
                type="button"
                disabled={descriptor.kind === "confirm" && confirmBusy}
                onClick={() => void handleActionClick(descriptor)}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
                  isPrimary
                    ? "bg-foreground text-background hover:opacity-90"
                    : "border border-border bg-[var(--surface-inset)] text-foreground hover:bg-[var(--surface-subtle)]",
                )}
              >
                <span>{label}</span>
              </button>
            );
          })}

          {fallbackOpenRoute && !hasOpenActionAlready && chat ? (
            <button
              type="button"
              onClick={() =>
                chat.runCardClientAction({
                  kind: "open-route",
                  label: "Open",
                  href: fallbackOpenRoute,
                })
              }
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-[var(--surface-inset)] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--surface-subtle)]"
            >
              <span>Open</span>
            </button>
          ) : null}

          {showContextualInsertButton &&
          effectiveItemId &&
          part.mediaType &&
          chat ? (
            <button
              type="button"
              onClick={() =>
                void chat.stageDocInsertFromEmbed({
                  mediaType: part.mediaType!,
                  itemId: effectiveItemId,
                  title: part.title,
                })
              }
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-[var(--surface-inset)] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--surface-subtle)]"
            >
              <FilePlus2 size={12} />
              <span>Insert into doc</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
