"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import {
  AudioLines,
  Box,
  Clapperboard,
  FileText,
  FolderTree,
  ImageIcon,
  LayoutGrid,
  ListMusic,
  Music2,
  ScanSearch,
  Scissors,
  UserRound,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { cn } from "cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { referenceKindLabel } from "@/lib/chat/references";
import type {
  ChatEntityReference,
  ChatReferenceKind,
} from "@/lib/chat/types";
import { studioJson } from "@/lib/media-client";
import { useMediaLinks } from "@/lib/use-media-links";

export function ReferenceKindIcon({
  kind,
  characterKind,
  size = 13,
  className,
}: {
  kind: ChatReferenceKind;
  characterKind?: "person" | "thing";
  size?: number;
  className?: string;
}): JSX.Element {
  const iconClass = cn("shrink-0", className);
  switch (kind) {
    case "narration":
      return <AudioLines size={size} className={iconClass} />;
    case "video":
      return <Video size={size} className={iconClass} />;
    case "image":
      return <ImageIcon size={size} className={iconClass} />;
    case "music":
      return <Music2 size={size} className={iconClass} />;
    case "sfx":
      return <Volume2 size={size} className={iconClass} />;
    case "analysis":
      return <ScanSearch size={size} className={iconClass} />;
    case "tree":
      return <FolderTree size={size} className={iconClass} />;
    case "tree-doc":
      return <FileText size={size} className={iconClass} />;
    case "production":
      return <Clapperboard size={size} className={iconClass} />;
    case "cut":
      return <Scissors size={size} className={iconClass} />;
    case "storyboard":
      return <LayoutGrid size={size} className={iconClass} />;
    case "character":
      return characterKind === "thing" ? (
        <Box size={size} className={iconClass} />
      ) : (
        <UserRound size={size} className={iconClass} />
      );
    case "playlist":
      return <ListMusic size={size} className={iconClass} />;
  }
}

export function CutStatusIndicator({
  status,
}: {
  status?: "review" | "approved" | "final" | "none";
}): JSX.Element | null {
  if (!status || status === "none") return null;
  const colorClass =
    status === "approved" || status === "final"
      ? "bg-[#2f9e44] dark:bg-[#3fb950]"
      : "bg-[#e3a008] dark:bg-[#f5a524]";
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", colorClass)}
    />
  );
}

/**
 * Aligned 20×20 lead icon column inside `ChatReferencePopover` rows so every
 * Studio entity kind has a distinct icon along a single quiet vertical axis.
 */
export function ReferenceLeadVisual({
  reference,
}: {
  reference: ChatEntityReference;
}): JSX.Element {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center text-ink-muted">
      <ReferenceKindIcon
        kind={reference.kind}
        characterKind={reference.characterKind}
        size={14}
      />
    </span>
  );
}

interface CharacterInspectResponse {
  id: string;
  slug: string;
  name: string;
  kind: "person" | "thing";
  latestVersion: number;
  latest: {
    version: number;
    ref: string;
    character: {
      description: string;
      delivery?: {
        register?: string;
      };
      voice: {
        provider: string;
        name?: string;
        id?: string;
        uses: string[];
      };
    };
    stills: Record<string, string>;
  } | null;
}

function CharacterInspectorContent({
  reference,
}: {
  reference: ChatEntityReference;
}): JSX.Element {
  const [detail, setDetail] = useState<CharacterInspectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    studioJson<CharacterInspectResponse>(
      `/api/v1/characters/${encodeURIComponent(reference.id)}`,
    )
      .then((res) => {
        if (!active) return;
        setDetail(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(
          err instanceof Error ? err.message : "Character unavailable.",
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reference.id]);

  const stillAssetId = useMemo(() => {
    if (reference.thumbnailAssetId) return reference.thumbnailAssetId;
    if (!detail?.latest?.stills) return null;
    return Object.values(detail.latest.stills)[0] ?? null;
  }, [detail, reference.thumbnailAssetId]);

  const { links } = useMediaLinks(stillAssetId ? [stillAssetId] : []);
  const portraitUrl = stillAssetId
    ? links[stillAssetId]?.thumbnail ?? links[stillAssetId]?.content ?? null
    : reference.thumbnailUrl ?? null;

  const isThing = (detail?.kind ?? reference.characterKind) === "thing";
  const versionNum = detail?.latest?.version ?? reference.subId ?? detail?.latestVersion;
  const voiceSummary = useMemo(() => {
    const v = detail?.latest?.character.voice;
    if (!v) return null;
    if (v.provider === "video-model") return "Video model voice";
    return `ElevenLabs “${v.name ?? v.id ?? "Voice"}”`;
  }, [detail]);

  const metaLine = [
    versionNum ? `v${versionNum}` : null,
    isThing ? "Prop" : null,
    voiceSummary,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3">
      <span className="inline-flex aspect-[4/3] w-14 shrink-0 items-center justify-center self-start overflow-hidden rounded-[6px] bg-foreground/[0.06] text-ink-faint">
        {portraitUrl ? (
          <img
            src={portraitUrl}
            alt={detail?.name ?? reference.title}
            className="size-full object-cover"
          />
        ) : isThing ? (
          <Box size={16} />
        ) : (
          <UserRound size={16} />
        )}
      </span>

      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-[13.5px] font-semibold text-foreground">
          {detail?.name ?? reference.title}
        </p>
        {metaLine ? (
          <p className="truncate text-[11.5px] text-ink-muted tabular-nums">
            {metaLine}
          </p>
        ) : null}

        {loading ? (
          <p className="text-xs text-ink-muted">Loading…</p>
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : detail?.latest?.character.delivery?.register ? (
          <p className="line-clamp-2 text-xs leading-[18px] text-ink-muted">
            {detail.latest.character.delivery.register}
          </p>
        ) : detail?.latest?.character.description ? (
          <p className="line-clamp-2 text-xs leading-[18px] text-ink-muted">
            {detail.latest.character.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Quiet optional secondary detail inside an inline chip — only compact numeric
 * metadata (clock timecodes like `02:02`, version `v1`, or `Draft`), never
 * shouting uppercase type labels.
 */
function compactChipDetail(reference: ChatEntityReference): string | null {
  if (reference.isLocalDraft) return "Draft";
  if (reference.kind === "character" && reference.subId) {
    return `v${reference.subId}`;
  }
  const meta = reference.metaLabel?.trim();
  if (!meta) return null;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(meta)) {
    return meta;
  }
  return null;
}

export interface ChatReferenceChipProps {
  reference: ChatEntityReference;
  /** Optional raw URI string preserved on `data-media-uri` for inline markdown citations. */
  rawUri?: string;
  onOpenRoute?: (href: string) => void;
  onRemove?: () => void;
  compact?: boolean;
}

/**
 * Cohesive Studio reference chip used across `ChatComposer`, user bubbles in
 * `ChatPanel`, and assistant inline citations in `ChatMarkdown`.
 */
export function ChatReferenceChip({
  reference,
  rawUri,
  onOpenRoute,
  onRemove,
  compact = false,
}: ChatReferenceChipProps): JSX.Element {
  const kindTitle = referenceKindLabel(reference.kind, reference.characterKind);
  const tooltipText = [kindTitle, reference.title, reference.subtitle]
    .filter(Boolean)
    .join(" · ");
  const detailText = compact ? null : compactChipDetail(reference);

  const innerContent = (
    <>
      <ReferenceKindIcon
        kind={reference.kind}
        characterKind={reference.characterKind}
        size={12}
        className="text-ink-muted"
      />
      {reference.kind === "cut" ? (
        <CutStatusIndicator status={reference.cutStatus} />
      ) : null}
      <span className="max-w-[176px] truncate font-medium text-foreground">
        {reference.title}
      </span>
      {detailText ? (
        <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
          {detailText}
        </span>
      ) : null}
    </>
  );

  const baseChipClass =
    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border bg-[var(--surface-inset)] px-2 align-baseline text-xs text-foreground transition-colors";
  const interactiveClass =
    "cursor-pointer hover:border-border-strong hover:bg-muted";

  if (onRemove) {
    return (
      <span
        title={tooltipText}
        data-reference-kind={reference.kind}
        data-media-uri={rawUri ?? reference.uri}
        data-route-href={reference.href}
        className={baseChipClass}
      >
        {reference.kind === "character" ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex min-w-0 cursor-pointer items-center gap-1.5"
              >
                {innerContent}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-72 p-3">
              <CharacterInspectorContent reference={reference} />
            </PopoverContent>
          </Popover>
        ) : onOpenRoute ? (
          <button
            type="button"
            onClick={() => onOpenRoute(reference.href)}
            className="inline-flex min-w-0 cursor-pointer items-center gap-1.5"
          >
            {innerContent}
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {innerContent}
          </span>
        )}
        <button
          type="button"
          aria-label={`Remove ${reference.title} reference`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-foreground"
        >
          <X size={11} />
        </button>
      </span>
    );
  }

  if (reference.kind === "character") {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={tooltipText}
            data-reference-kind={reference.kind}
            data-media-uri={rawUri ?? reference.uri}
            data-route-href={reference.href}
            className={cn(baseChipClass, interactiveClass)}
          >
            {innerContent}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-72 p-3">
          <CharacterInspectorContent reference={reference} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <button
      type="button"
      title={tooltipText}
      data-reference-kind={reference.kind}
      data-media-uri={rawUri ?? reference.uri}
      data-route-href={reference.href}
      onClick={() => onOpenRoute?.(reference.href)}
      className={cn(baseChipClass, Boolean(onOpenRoute) && interactiveClass)}
    >
      {innerContent}
    </button>
  );
}
