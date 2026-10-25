"use client";

import { cn } from "cn";
import { Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { usePrivateMedia } from "../media/private-media";
import { MermaidBlock } from "./mermaid-block";
import { REMIX_ACTIONS_BY_SOURCE } from "../../lib/media-remix";
import type {
  MediaRemixKind,
  MediaRemixRequest,
  MediaRemixResult,
  TreeMediaRef,
} from "../../lib/tree-types";

export interface DocumentMediaCardProps {
  mediaRef: TreeMediaRef;
  alt?: string;
  defaultComposerOpen?: boolean;
  onRemixMedia?: (request: MediaRemixRequest) => Promise<MediaRemixResult>;
  className?: string;
}

const PLACEMENT_OPTIONS: ReadonlyArray<{
  value: MediaRemixRequest["placement"];
  label: string;
}> = [
  { value: "insert_below", label: "Insert below" },
  { value: "replace", label: "Replace in document" },
  { value: "library_only", label: "Save to library only" },
];

export function resolvePrivateMediaContentPath(mediaRef: TreeMediaRef): string | null {
  if (mediaRef.type === "mermaid") return null;
  if (mediaRef.type === "narration") {
    return `/api/v1/narrations/${encodeURIComponent(mediaRef.id)}/audio`;
  }
  const assetId = mediaRef.generationId ?? mediaRef.id;
  return `/api/v1/assets/${encodeURIComponent(assetId)}/content`;
}

export function DocumentMediaCard({
  mediaRef,
  alt,
  defaultComposerOpen = false,
  onRemixMedia,
  className,
}: DocumentMediaCardProps) {
  const actions = REMIX_ACTIONS_BY_SOURCE[mediaRef.type] ?? REMIX_ACTIONS_BY_SOURCE.image;
  const defaultKind: MediaRemixKind = actions[0]?.kind ?? "image_to_image";

  const [composerOpen, setComposerOpen] = useState(defaultComposerOpen);
  const [selectedKind, setSelectedKind] = useState<MediaRemixKind>(defaultKind);
  const [prompt, setPrompt] = useState("");
  const [placement, setPlacement] =
    useState<MediaRemixRequest["placement"]>("insert_below");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const contentPath = resolvePrivateMediaContentPath(mediaRef);
  const { url, error: mediaError } = usePrivateMedia(contentPath);
  const accessibleLabel = alt?.trim() || `${mediaRef.type} ${mediaRef.id}`;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onRemixMedia || submitting) return;

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const source: MediaRemixRequest["source"] =
        mediaRef.type === "mermaid"
          ? ({
              type: "mermaid",
              id: mediaRef.id,
              code: mediaRef.id,
            } as TreeMediaRef & { type: "mermaid"; code: string })
          : mediaRef;

      await onRemixMedia({
        kind: selectedKind,
        source,
        prompt: prompt.trim(),
        placement,
      });
      setPrompt("");
      setComposerOpen(false);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Could not generate remixed media.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const remixTriggerButton = (
    <button
      type="button"
      aria-expanded={composerOpen}
      aria-label={`Remix ${accessibleLabel}`}
      onClick={() => setComposerOpen((prev) => !prev)}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-[11px] font-medium transition-colors cursor-pointer",
        composerOpen
          ? "border-primary bg-primary/10 text-primary"
          : "border-border/60 bg-surface-inset/80 text-ink-muted hover:border-border-strong hover:bg-muted hover:text-foreground",
      )}
    >
      <Sparkles size={11} />
      <span>Remix</span>
    </button>
  );

  const composerDrawer = composerOpen ? (
    <form
      onSubmit={handleSubmit}
      aria-label="Cross-modal media remix composer"
      className="grid w-full min-w-0 gap-3 border-t border-border/50 bg-surface-inset/40 p-3.5"
    >
      <div
        role="radiogroup"
        aria-label="Remix action"
        className="flex flex-wrap items-center gap-1.5"
      >
        {actions.map((action) => {
          const active = selectedKind === action.kind;
          return (
            <button
              key={action.kind}
              type="button"
              role="radio"
              aria-checked={active}
              data-remix-kind={action.kind}
              onClick={() => setSelectedKind(action.kind)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface-card text-foreground hover:bg-muted",
              )}
            >
              {action.label}
            </button>
          );
        })}
      </div>

      <input
        type="text"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe how to remix or transform this media..."
        aria-label="Remix instructions"
        className="w-full rounded-md border border-border bg-surface-card px-3 py-2 text-sm text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="radiogroup"
          aria-label="Placement in document"
          className="inline-flex items-center rounded-md border border-border/60 bg-surface-inset/60 p-0.5"
        >
          {PLACEMENT_OPTIONS.map((option) => {
            const active = placement === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-placement={option.value}
                onClick={() => setPlacement(option.value)}
                className={cn(
                  "rounded px-2 py-1 text-xs transition-colors cursor-pointer",
                  active
                    ? "bg-surface-card font-medium text-foreground shadow-2xs"
                    : "text-ink-muted hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          {submitting ? "Generating..." : "Generate"}
        </button>
      </div>

      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </form>
  ) : null;

  if (mediaRef.type === "mermaid") {
    return (
      <figure
        data-media-type="mermaid"
        data-media-id={mediaRef.id}
        className={cn("grid w-full min-w-0", className)}
      >
        <MermaidBlock
          code={mediaRef.id}
          className="w-full"
          headerActions={remixTriggerButton}
          footer={composerDrawer}
        />
      </figure>
    );
  }

  return (
    <figure
      data-media-type={mediaRef.type}
      data-media-id={mediaRef.id}
      className={cn(
        "grid w-full min-w-0 overflow-hidden rounded-lg border border-border bg-surface-card shadow-2xs",
        className,
      )}
    >
      <div className="flex h-9 items-center justify-between border-b border-border/50 bg-surface-inset/40 px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint select-none">
            {mediaRef.type}
          </span>
          {alt?.trim() ? (
            <span className="truncate text-xs text-ink-muted">{alt.trim()}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">{remixTriggerButton}</div>
      </div>

      <div className="grid w-full min-w-0 bg-surface-card">
        {mediaRef.type === "video" ? (
          <video
            src={url || undefined}
            controls
            playsInline
            aria-label={accessibleLabel}
            data-media-path={contentPath ?? undefined}
            className="w-full bg-surface-inset"
          />
        ) : mediaRef.type === "music" ||
          mediaRef.type === "sfx" ||
          mediaRef.type === "narration" ? (
          <div className="grid w-full gap-2 p-4">
            <span className="font-mono text-xs text-ink-muted">{accessibleLabel}</span>
            <audio
              src={url || undefined}
              controls
              aria-label={accessibleLabel}
              data-media-path={contentPath ?? undefined}
              className="w-full"
            />
          </div>
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={accessibleLabel}
            data-media-path={contentPath ?? undefined}
            className="w-full object-cover"
          />
        ) : (
          <div
            role="img"
            aria-label={accessibleLabel}
            data-media-path={contentPath ?? undefined}
            className="grid min-h-[10rem] w-full place-items-center p-4 text-xs text-ink-muted"
          >
            <span>{mediaError || accessibleLabel}</span>
          </div>
        )}
      </div>

      {composerDrawer}
    </figure>
  );
}
