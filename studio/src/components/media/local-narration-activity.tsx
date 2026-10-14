"use client";

import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowUpRight,
  Loader2,
  PenLine,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNarration } from "@/components/shell/narration-provider";
import type { GenerationJob } from "@/lib/use-generation-queue";
import { useWorkspace } from "@/components/shell/workspace-provider";

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ActiveJobCard({
  job,
  onCancel,
}: {
  job: GenerationJob;
  onCancel: (id: string) => void;
}) {
  const router = useRouter();
  const hasProgress = job.totalChunks > 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.max(8, Math.round((job.completedChunks / job.totalChunks) * 100)))
    : null;

  return (
    <div className="group rounded-lg border border-border bg-card p-4 shadow-2xs transition-all grid gap-3">
      {/* Top track grid: status, title, actions, metadata */}
      <div className="item-track-grid">
        {/* Track: Status indicator */}
        <div className="track-status">
          <span className="inline-flex size-5 flex-none items-center justify-center rounded-sm bg-primary/10 text-primary">
            <Loader2 size={12} className="animate-spin" />
          </span>
        </div>

        {/* Track: Title text */}
        <div className="track-title">
          <h3 className="block min-w-0 text-[0.95rem] font-semibold text-foreground [overflow-wrap:anywhere] sm:truncate">
            {job.title}
          </h3>
        </div>

        {/* Track: Action controls */}
        <div className="track-actions">
          {job.narrationId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push(`/narration/${job.narrationId}`)}
              className="h-7 gap-1 px-2 text-xs font-medium text-foreground"
            >
              <span>View</span>
              <ArrowUpRight size={12} />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onCancel(job.id)}
            className="h-7 px-2 text-xs text-ink-muted hover:text-destructive"
            title="Cancel generation"
          >
            <X size={13} strokeWidth={2} />
            <span className="sr-only">Cancel</span>
          </Button>
        </div>

        {/* Track: Metadata */}
        <div className="track-body">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.75rem] text-ink-muted">
            <span className="font-medium text-foreground">{job.voice}</span>
            {job.rewriteForNarration ? (
              <span className="inline-flex items-center gap-1 text-primary">
                <Sparkles size={11} /> Adapted for ear
              </span>
            ) : null}
            <span>Started {relativeTime(job.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Full-width Progress Bar & Status Text */}
      <div className="grid gap-1.5 pt-1">
        <div className="flex items-center justify-between text-[0.75rem]">
          <span className="font-medium text-ink-muted">
            {job.status === "starting"
              ? "Connecting to synthesis engine…"
              : job.totalChunks > 0
                ? `Synthesizing audio (${job.completedChunks} / ${job.totalChunks} chunks)`
                : `Synthesizing audio (${job.completedChunks} chunks)`}
          </span>
          {progressPercent !== null ? (
            <span className="font-mono text-xs tabular-nums text-ink-faint">
              {progressPercent}%
            </span>
          ) : null}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          {progressPercent !== null ? (
            <div
              className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          ) : (
            <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/70" />
          )}
        </div>
      </div>
    </div>
  );
}

function FailedJobCard({
  job,
  onDismiss,
  onEditInStudio,
  onRetry,
}: {
  job: GenerationJob;
  onDismiss: (id: string) => void;
  onEditInStudio: (job: GenerationJob) => void;
  onRetry: (id: string) => void;
}) {
  const isPolicy = job.errorCategory === "policy";

  return (
    <div className="group item-track-grid rounded-lg border border-destructive/30 bg-destructive/5 p-4 shadow-2xs">
      {/* Track: Status */}
      <div className="track-status">
        <AlertCircle size={14} className="flex-none text-destructive" />
      </div>

      {/* Track: Title */}
      <div className="track-title flex items-center gap-2 flex-wrap">
        <span className="block min-w-0 text-[0.9rem] font-medium text-foreground [overflow-wrap:anywhere] sm:truncate">
          {job.title}
        </span>
        {isPolicy && (
          <span className="font-mono text-[0.68rem] uppercase tracking-wider text-destructive/90 font-medium">
            Policy Block
          </span>
        )}
      </div>

      {/* Track: Actions */}
      <div className="track-actions flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onEditInStudio(job)}
          className="h-7 gap-1 px-2.5 text-xs text-foreground hover:bg-background"
          title="Open draft in Studio to edit prompt or text"
        >
          <PenLine size={12} />
          <span>Edit in Studio</span>
        </Button>
        {job.errorRetryable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRetry(job.id)}
            className="h-7 gap-1 px-2.5 text-xs text-foreground hover:bg-background"
            title="Retry narration"
          >
            <RotateCw size={12} />
            <span>Retry</span>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(job.id)}
          className="h-7 px-2 text-xs text-ink-muted hover:text-foreground"
        >
          Dismiss
        </Button>
      </div>

      {/* Track: Error */}
      <div className="track-body space-y-1">
        <p className="text-[0.8rem] text-destructive/90 leading-relaxed font-normal">
          {job.errorMessage || "Generation failed"}
        </p>
        {job.errorActionableHint && (
          <p className="text-[0.75rem] text-ink-muted leading-relaxed">
            {job.errorActionableHint}
          </p>
        )}
      </div>
    </div>
  );
}

export function LocalNarrationActivity({ type }: { type: string }) {
  const { generationQueue } = useNarration();
  const { store } = useWorkspace();
  const router = useRouter();
  if (type && type !== 'narration') return null;
  const jobs = generationQueue.jobs.filter(job => job.status !== 'ready');
  const edit = (job: GenerationJob) => {
    const id = crypto.randomUUID();
    store.setDraft(id, { markdown: job.markdown, voice: { provider: job.voiceProvider, id: job.voiceId, name: job.voice }, promptStyle: job.promptStyle, rewriteForNarration: job.rewriteForNarration, rewriteInstructions: job.rewriteInstructions, speed: job.speed, visibility: job.visibility });
    router.push(`/studio?draft=${id}`);
  };
  return <>{jobs.map(job => job.status === 'error' ? <FailedJobCard key={job.id} job={job} onRetry={id => { void generationQueue.retryJob(id); }} onDismiss={generationQueue.dismissJob} onEditInStudio={edit} /> : <ActiveJobCard key={job.id} job={job} onCancel={generationQueue.cancelJob} />)}</>;
}
