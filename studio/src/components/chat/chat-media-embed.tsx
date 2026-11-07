"use client";

import { useEffect, useRef, useState, type JSX } from "react";
import {
  AudioLines,
  FilePlus2,
  Music,
  Pause,
  Play,
  ScanSearch,
  Volume2,
} from "lucide-react";
import { usePrivateMedia } from "@/components/media/private-media";
import { useNarration } from "@/components/shell/narration-provider";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";
import { useActiveChatViewContext } from "@/lib/chat-context-bridge";
import { formatClockSeconds, type ChatMediaType } from "@/lib/chat/types";
import { studioJson } from "@/lib/media-client";
import { ChatMarkdown, mediaRouteForItem } from "./chat-markdown";
import { useOptionalChat } from "./chat-provider";

export interface ChatMediaEmbedProps {
  mediaType: ChatMediaType;
  itemId: string;
  generationId?: string | null;
  title: string;
  subtitle?: string;
  excerptMarkdown?: string;
  clipStartSeconds?: number;
  onOpenRoute?: (href: string) => void;
  onSeekTimestamp?: (seconds: number) => void;
}

interface MediaAssetLookupResponse {
  title?: string;
  durationMs?: number;
  sourcePreview?: string;
  assets?: Array<{ id: string; durationMs?: number }>;
  result?: {
    durationSeconds?: number | null;
    assets?: Array<{ id: string; durationMs?: number }>;
  } | null;
}

function itemLookupEndpoint(mediaType: ChatMediaType, itemId: string): string | null {
  const encoded = encodeURIComponent(itemId);
  switch (mediaType) {
    case "image":
      return `/api/v1/images/${encoded}`;
    case "video":
      return `/api/v1/videos/${encoded}`;
    case "music":
      return `/api/v1/music/${encoded}`;
    case "sfx":
      return `/api/v1/sfx/${encoded}`;
    case "analysis":
      return `/api/v1/analyses/${encoded}`;
    case "narration":
      return null;
  }
}

export function ChatMediaEmbed({
  mediaType,
  itemId,
  generationId,
  title,
  subtitle,
  excerptMarkdown,
  clipStartSeconds,
  onOpenRoute,
  onSeekTimestamp,
}: ChatMediaEmbedProps): JSX.Element {
  const chat = useOptionalChat();
  const workspace = useOptionalWorkspace();
  const activeView = useActiveChatViewContext();

  let narrationCtx: ReturnType<typeof useNarration> | null = null;
  try {
    narrationCtx = useNarration();
  } catch {
    narrationCtx = null;
  }

  const [resolvedAssetId, setResolvedAssetId] = useState<string | null>(null);
  const [resolvedDurationSec, setResolvedDurationSec] = useState<number | null>(null);
  const [resolvedExcerpt, setResolvedExcerpt] = useState<string>(excerptMarkdown ?? "");
  const [resolvedTitle, setResolvedTitle] = useState<string>(title);
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const [inlineAudioPlaying, setInlineAudioPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setResolvedTitle(title);
  }, [title]);

  useEffect(() => {
    if (excerptMarkdown !== undefined) {
      setResolvedExcerpt(excerptMarkdown);
    }
  }, [excerptMarkdown]);

  useEffect(() => {
    if (mediaType === "narration") return;
    if (mediaType === "analysis" && excerptMarkdown) return;

    const controller = new AbortController();
    const endpoint = generationId
      ? `/api/v1/generations/${encodeURIComponent(generationId)}`
      : itemLookupEndpoint(mediaType, itemId);

    if (!endpoint) return;

    void studioJson<MediaAssetLookupResponse>(endpoint, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const asset = res.result?.assets?.[0] ?? res.assets?.[0];
        if (asset?.id) {
          setResolvedAssetId(asset.id);
        }
        const durSec =
          res.result?.durationSeconds ??
          (typeof asset?.durationMs === "number"
            ? asset.durationMs / 1000
            : typeof res.durationMs === "number"
              ? res.durationMs / 1000
              : null);
        if (durSec !== null) {
          setResolvedDurationSec(durSec);
        }
        if (res.title && !title) {
          setResolvedTitle(res.title);
        }
        if (mediaType === "analysis" && res.sourcePreview && !excerptMarkdown) {
          setResolvedExcerpt(res.sourcePreview);
        }
      })
      .catch(() => {
        /* Fallback content path will be attempted via itemId if itemId is already an assetId. */
      });

    return () => controller.abort();
  }, [mediaType, itemId, generationId, excerptMarkdown, title]);

  const privateContentPath =
    mediaType === "analysis"
      ? null
      : mediaType === "narration"
        ? narrationCtx
          ? null
          : `/api/v1/narrations/${encodeURIComponent(itemId)}/audio`
        : resolvedAssetId
          ? `/api/v1/assets/${encodeURIComponent(resolvedAssetId)}/content`
          : null;

  const media = usePrivateMedia(privateContentPath);

  const openHref = mediaRouteForItem(mediaType, itemId);
  const isTreeDocActive = activeView?.surface === "tree-doc";

  const handleOpen = () => {
    if (onOpenRoute) {
      onOpenRoute(openHref);
      return;
    }
    if (workspace) {
      const tab = workspace.store.visit(openHref);
      if (tab) {
        workspace.openView(tab);
        return;
      }
    }
    if (typeof window !== "undefined") {
      window.location.assign(openHref);
    }
  };

  const handleInsertIntoDoc = () => {
    if (!chat) return;
    void chat.stageDocInsertFromEmbed({
      mediaType,
      itemId,
      title: resolvedTitle || title || mediaType,
    });
  };

  const footerButtonClass =
    "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border bg-[var(--surface-inset)] px-2 text-xs text-ink-muted transition-colors hover:bg-[var(--surface-subtle)] hover:text-foreground";

  if (mediaType === "narration" || mediaType === "music" || mediaType === "sfx") {
    const isNarrationActiveInGlobal =
      mediaType === "narration" &&
      narrationCtx !== null &&
      narrationCtx.stream.id === itemId;
    const isPlaying = isNarrationActiveInGlobal
      ? narrationCtx!.stream.playing
      : inlineAudioPlaying;

    const handleToggleAudio = () => {
      if (mediaType === "narration" && narrationCtx) {
        if (narrationCtx.stream.id === itemId && narrationCtx.stream.player) {
          if (narrationCtx.stream.playing) {
            narrationCtx.stream.player.pause();
          } else {
            narrationCtx.stream.player.play();
          }
          return;
        }
        narrationCtx.playNarration(
          itemId,
          clipStartSeconds ? Math.round(clipStartSeconds * 1000) : undefined,
        );
        return;
      }

      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        if (clipStartSeconds && audio.currentTime === 0) {
          audio.currentTime = clipStartSeconds;
        }
        void audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    };

    const metaText =
      subtitle ||
      (resolvedDurationSec !== null ? formatClockSeconds(resolvedDurationSec) : null);

    return (
      <div
        data-embed-type={mediaType}
        data-embed-id={itemId}
        className="flex min-h-[52px] w-full min-w-0 items-center justify-between gap-2.5 rounded-xl border border-border bg-[var(--surface-card)] px-3 py-2"
      >
        {privateContentPath ? (
          <audio
            ref={audioRef}
            src={media.url || undefined}
            preload="metadata"
            onPlay={() => setInlineAudioPlaying(true)}
            onPause={() => setInlineAudioPlaying(false)}
            onEnded={() => setInlineAudioPlaying(false)}
            className="hidden"
          />
        ) : null}

        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            aria-label={isPlaying ? `Pause ${resolvedTitle}` : `Play ${resolvedTitle}`}
            onClick={handleToggleAudio}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
          >
            {isPlaying ? (
              <Pause size={13} className="fill-current" />
            ) : (
              <Play size={13} className="fill-current" />
            )}
          </button>

          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-foreground">
              {resolvedTitle || "Untitled audio"}
            </span>
            <span className="t-mono flex items-center gap-1 truncate text-[11px] text-ink-muted">
              {mediaType === "narration" ? (
                <AudioLines size={11} className="shrink-0" />
              ) : mediaType === "music" ? (
                <Music size={11} className="shrink-0" />
              ) : (
                <Volume2 size={11} className="shrink-0" />
              )}
              <span>{metaText || mediaType}</span>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isTreeDocActive ? (
            <button
              type="button"
              onClick={handleInsertIntoDoc}
              className={footerButtonClass}
            >
              <FilePlus2 size={11} />
              <span>Insert into doc</span>
            </button>
          ) : null}
          {mediaType !== "sfx" ? (
            <button type="button" onClick={handleOpen} className={footerButtonClass}>
              <span>Open</span>
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (mediaType === "analysis") {
    const hasLongExcerpt =
      resolvedExcerpt.length > 220 || resolvedExcerpt.split("\n").length > 4;
    return (
      <div
        data-embed-type="analysis"
        data-embed-id={itemId}
        className="flex w-full min-w-0 flex-col gap-2 rounded-xl border border-border bg-[var(--surface-card)] p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <ScanSearch size={14} className="shrink-0 text-ink-muted" />
            <span className="truncate text-[13px] font-medium text-foreground">
              {resolvedTitle || "Video Analysis"}
            </span>
          </div>
          {subtitle ? (
            <span className="t-mono shrink-0 text-[11px] text-ink-faint">{subtitle}</span>
          ) : null}
        </div>

        {resolvedExcerpt ? (
          <div className={analysisExpanded ? "min-w-0" : "line-clamp-4 min-w-0"}>
            <ChatMarkdown
              markdown={resolvedExcerpt}
              onOpenRoute={onOpenRoute ?? handleOpen}
              onSeekTimestamp={onSeekTimestamp}
              className="text-xs text-ink-muted"
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={handleOpen} className={footerButtonClass}>
              <span>Open</span>
            </button>
            {isTreeDocActive ? (
              <button
                type="button"
                onClick={handleInsertIntoDoc}
                className={footerButtonClass}
              >
                <FilePlus2 size={11} />
                <span>Insert into doc</span>
              </button>
            ) : null}
          </div>
          {hasLongExcerpt ? (
            <button
              type="button"
              onClick={() => setAnalysisExpanded((prev) => !prev)}
              className="cursor-pointer text-xs text-ink-faint transition-colors hover:text-foreground"
            >
              {analysisExpanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (mediaType === "video") {
    return (
      <div
        data-embed-type="video"
        data-embed-id={itemId}
        className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--surface-card)]"
      >
        <video
          ref={videoRef}
          src={media.url || undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={resolvedTitle || "Video preview"}
          onLoadedMetadata={(event) => {
            if (typeof clipStartSeconds === "number" && clipStartSeconds > 0) {
              event.currentTarget.currentTime = clipStartSeconds;
            }
          }}
          className="aspect-video w-full bg-[var(--surface-inset)] object-cover"
        />
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-medium text-foreground">
              {resolvedTitle || "Video"}
            </span>
            {subtitle ? (
              <span className="t-mono truncate text-[11px] text-ink-muted">
                {subtitle}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {chat ? (
              <button
                type="button"
                onClick={() => {
                  chat.setPendingSlashCommand("analyze");
                  chat.requestComposerFocus();
                }}
                className={footerButtonClass}
              >
                <span>Analyze</span>
              </button>
            ) : null}
            {isTreeDocActive ? (
              <button
                type="button"
                onClick={handleInsertIntoDoc}
                className={footerButtonClass}
              >
                <FilePlus2 size={11} />
                <span>Insert into doc</span>
              </button>
            ) : null}
            <button type="button" onClick={handleOpen} className={footerButtonClass}>
              <span>Open</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Image embed (`mediaType === 'image'`)
  return (
    <div
      data-embed-type="image"
      data-embed-id={itemId}
      className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--surface-card)]"
    >
      {media.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media.url}
          alt={resolvedTitle || "Generated image"}
          className="max-h-56 w-full bg-[var(--surface-inset)] object-cover"
        />
      ) : (
        <div className="grid h-40 w-full place-items-center bg-[var(--surface-inset)] p-3 text-xs text-ink-muted">
          <span>{media.error || resolvedTitle || "Image preview"}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-foreground">
            {resolvedTitle || "Image"}
          </span>
          {subtitle ? (
            <span className="t-mono truncate text-[11px] text-ink-muted">{subtitle}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isTreeDocActive ? (
            <button
              type="button"
              onClick={handleInsertIntoDoc}
              className={footerButtonClass}
            >
              <FilePlus2 size={11} />
              <span>Insert into doc</span>
            </button>
          ) : null}
          <button type="button" onClick={handleOpen} className={footerButtonClass}>
            <span>Open</span>
          </button>
        </div>
      </div>
    </div>
  );
}
