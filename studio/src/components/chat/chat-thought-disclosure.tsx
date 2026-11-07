"use client";

import { useState, type JSX } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "cn";

export interface ChatThoughtDisclosureProps {
  streaming: boolean;
  headline: string | null;
  steps: readonly string[];
  durationMs?: number | null;
}

export function ChatThoughtDisclosure({
  streaming,
  headline,
  steps,
  durationMs = null,
}: ChatThoughtDisclosureProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  const hasThoughtContent = Boolean(headline) || steps.length > 0;
  const isCompleted = !streaming || durationMs !== null;

  if (!hasThoughtContent && (durationMs === null || durationMs === undefined)) {
    return null;
  }

  if (!isCompleted) {
    const activeLine = headline || steps[steps.length - 1] || "";
    if (!activeLine) return null;
    return (
      <div className="flex h-6 min-w-0 items-center">
        <span className="t-meta truncate text-ink-muted transition-opacity duration-150">
          {`Thinking — ${activeLine}`}
        </span>
      </div>
    );
  }

  const label =
    durationMs !== null && durationMs >= 1000
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : `Thought · ${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="inline-flex h-6 w-fit cursor-pointer items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-ink-muted"
      >
        <ChevronRight
          size={13}
          className={cn(
            "shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <span>{label}</span>
      </button>
      {expanded && steps.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-l border-border px-3 py-1.5">
          {steps.map((step, index) => (
            <p key={index} className="t-meta min-w-0 break-words text-ink-muted">
              {step}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
