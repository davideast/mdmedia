"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  ListOrdered,
  Loader2,
  PenLine,
  Play,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { deleteNarration, watchMyNarrations } from "@/lib/narrations";
import type { GenerationJob } from "@/lib/use-generation-queue";
import type { Narration } from "@/lib/types";

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
          <h3 className="truncate text-[0.95rem] font-semibold text-foreground">
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

function CompletedJobCard({ job }: { job: GenerationJob }) {
  const router = useRouter();

  return (
    <div className="group item-track-grid rounded-lg border border-border/80 bg-card/60 p-3.5 transition-colors hover:bg-card">
      {/* Track: Status */}
      <div className="track-status">
        <CheckCircle2 size={14} className="flex-none text-primary" />
      </div>

      {/* Track: Title */}
      <div className="track-title">
        <span className="truncate text-[0.9rem] font-medium text-foreground">
          {job.title}
        </span>
      </div>

      {/* Track: Actions */}
      <div className="track-actions">
        {job.narrationId ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/narration/${job.narrationId}`)}
            className="h-7 gap-1.5 px-2.5 text-xs font-medium"
          >
            <Play size={11} strokeWidth={2.5} className="fill-current" />
            <span>Open</span>
          </Button>
        ) : null}
      </div>

      {/* Track: Metadata */}
      <div className="track-body">
        <div className="flex items-center gap-x-2.5 text-[0.75rem] text-ink-muted">
          <span>{job.voice}</span>
          <span>Ready {relativeTime(job.updatedAt)}</span>
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
        <span className="truncate text-[0.9rem] font-medium text-foreground">
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

export default function QueuePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { generationQueue, setDraft } = useNarration();
  const [firestoreNarrations, setFirestoreNarrations] = useState<Narration[]>([]);

  const handleEditInStudio = (job: GenerationJob) => {
    setDraft({
      markdown: job.markdown,
      voice: job.voice,
      promptStyle: job.promptStyle,
      rewriteForNarration: job.rewriteForNarration,
      rewriteInstructions: job.rewriteInstructions,
      visibility: job.visibility,
    });
    router.push("/studio");
  };

  const handleRetry = (jobId: string) => {
    void generationQueue.retryJob(jobId);
  };

  useEffect(() => {
    if (!user) return;
    return watchMyNarrations(user.uid, setFirestoreNarrations);
  }, [user]);

  // Find any Firestore narrations currently in 'streaming' status that aren't already represented in local jobs
  const knownNarrationIds = useMemo(
    () => new Set(generationQueue.jobs.map((j) => j.narrationId).filter(Boolean)),
    [generationQueue.jobs],
  );

  const orphanStreamingNarrations = useMemo(
    () =>
      firestoreNarrations.filter(
        (n) => n.status === "streaming" && !knownNarrationIds.has(n.id),
      ),
    [firestoreNarrations, knownNarrationIds],
  );

  const activeJobs = generationQueue.jobs.filter(
    (j) => j.status === "queued" || j.status === "starting" || j.status === "streaming",
  );
  const completedJobs = generationQueue.jobs.filter((j) => j.status === "ready");
  const failedJobs = generationQueue.jobs.filter((j) => j.status === "error");

  const handleCancelOrphan = (id: string) => {
    try {
      void deleteNarration(id);
      toast.info("Generation cancelled and data deleted");
    } catch {
      toast.error("Could not cancel generation.");
    }
  };

  const totalActive = activeJobs.length + orphanStreamingNarrations.length;
  const hasJobs =
    generationQueue.jobs.length > 0 || orphanStreamingNarrations.length > 0;

  return (
    <WorkbenchPanel
      title="Queue"
      icon={<ListOrdered size={13} strokeWidth={2} />}
      viewGrid
      actions={
        completedJobs.length > 0 || failedJobs.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={generationQueue.clearCompleted}
            className="h-7 gap-1 px-2 text-xs text-ink-muted hover:text-foreground"
          >
            <Trash2 size={12} strokeWidth={2} />
            <span>Clear finished</span>
          </Button>
        ) : null
      }
    >
      {!hasJobs ? (
        <div className="col-span-full grid place-items-center gap-3 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40 text-ink-muted">
            <ListOrdered size={24} strokeWidth={1.5} />
          </div>
          <div className="grid gap-1">
            <h2 className="text-[1.05rem] font-semibold text-foreground">
              Queue is empty
            </h2>
            <p className="max-w-sm text-[0.85rem] text-ink-muted">
              When you click &ldquo;Start Narration&rdquo; from the Studio, jobs
              process here in the background without interrupting your listening.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/studio">Go to Studio</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Active section */}
          <section className="grid gap-3">
            <h2 className="t-label">
              Processing ({totalActive})
            </h2>

            {totalActive === 0 ? (
              <p className="rounded-lg border border-dashed border-border/80 p-4 text-center text-[0.85rem] text-ink-muted">
                No active generations right now.
              </p>
            ) : (
              <div className="grid gap-3">
                {activeJobs.map((job) => (
                  <ActiveJobCard
                    key={job.id}
                    job={job}
                    onCancel={generationQueue.cancelJob}
                  />
                ))}

                {orphanStreamingNarrations.map((n) => (
                  <div
                    key={n.id}
                    className="group item-track-grid rounded-lg border border-border bg-card p-4 shadow-2xs"
                  >
                    <div className="track-status">
                      <Loader2 size={13} className="animate-spin text-primary" />
                    </div>
                    <div className="track-title">
                      <span className="truncate text-[0.95rem] font-semibold text-foreground">
                        {n.title}
                      </span>
                    </div>
                    <div className="track-actions">
                      <Button asChild variant="outline" size="sm" className="h-7 gap-1 text-xs">
                        <Link href={`/narration/${n.id}`}>
                          <span>View</span>
                          <ArrowUpRight size={12} />
                        </Link>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancelOrphan(n.id)}
                        className="h-7 px-2 text-xs text-ink-muted hover:text-destructive"
                        title="Cancel generation"
                      >
                        <X size={13} strokeWidth={2} />
                        <span className="sr-only">Cancel</span>
                      </Button>
                    </div>
                    <div className="track-body">
                      <div className="flex items-center gap-x-2.5 text-[0.75rem] text-ink-muted">
                        <span>{n.voice}</span>
                        <span>Synthesizing on server</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Completed section */}
          {completedJobs.length > 0 ? (
            <section className="grid gap-3 border-t border-border/60 pt-6">
              <h2 className="t-label">Completed ({completedJobs.length})</h2>
              <div className="grid gap-2">
                {completedJobs.map((job) => (
                  <CompletedJobCard key={job.id} job={job} />
                ))}
              </div>
            </section>
          ) : null}

          {/* Failed section */}
          {failedJobs.length > 0 ? (
            <section className="grid gap-3 border-t border-border/60 pt-6">
              <h2 className="t-label text-destructive">Failed ({failedJobs.length})</h2>
              <div className="grid gap-2">
                {failedJobs.map((job) => (
                  <FailedJobCard
                    key={job.id}
                    job={job}
                    onDismiss={generationQueue.dismissJob}
                    onEditInStudio={handleEditInStudio}
                    onRetry={handleRetry}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </WorkbenchPanel>
  );
}
