"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines, Clock, Loader2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useNarration } from "@/components/shell/narration-provider";
import { useWorkspace } from "@/components/shell/workspace-provider";
import { useAuth } from "@/lib/auth-context";
import { watchMyNarrations } from "@/lib/narrations";
import { DEFAULT_TTS_MODEL, VOICE_PROVIDER_LABEL, type Narration } from "@/lib/types";

const MIN_CHARS = 40;

function relative(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function HistoryRow({ narration }: { narration: Narration }) {
  return (
    <Link
      href={`/narration/${narration.id}`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-md px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <span className="t-card-title truncate">{narration.title}</span>
      <span className="t-meta flex-none tabular-nums">{relative(narration.createdAt)}</span>
    </Link>
  );
}

export default function StudioPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const { draft, setDraft, generationQueue } = useNarration();
  const { state: workspace, store, draftId, replaceCurrent, storageUnavailable } = useWorkspace();
  const [history, setHistory] = useState<Narration[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user === null) return;
    return watchMyNarrations(user.uid, setHistory);
  }, [user]);

  const tooShort = draft.markdown.trim().length < MIN_CHARS;

  const create = async () => {
    const markdownToSynthesize = draft.markdown.trim();
    if (markdownToSynthesize.length < MIN_CHARS) return;
    setSubmitting(true);
    try {
      const queued = await generationQueue.queueNarration({
        markdown: markdownToSynthesize,
        voice: draft.voice.name,
        voiceProvider: draft.voice.provider,
        voiceId: draft.voice.id,
        model: draft.voice.provider === "gemini"
          ? profile?.settings.defaultGeminiModel ?? DEFAULT_TTS_MODEL
          : undefined,
        promptStyle: draft.voice.provider === "gemini" ? draft.promptStyle : "",
        rewriteForNarration: draft.rewriteForNarration,
        rewriteInstructions: draft.rewriteInstructions?.trim() || undefined,
        structureMarkdown: draft.structureMarkdown,
        visibility: draft.visibility,
        speed: draft.speed,
        verbalizeDiagrams: draft.verbalizeDiagrams,
      });
      store.clearDraft(draftId);
      replaceCurrent(`/narration/${queued.narrationId}`, markdownToSynthesize.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80));
      toast.success("Narration queued for processing", {
        action: {
          label: "View Queue",
          onClick: () => router.push("/queue"),
        },
      });
    } catch {
      toast.error("Could not queue narration. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WorkbenchPanel
      workspacePage
      title={draft.markdown.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 80) || "New narration"}
      icon={<AudioLines size={13} strokeWidth={2} />}
      bodyClassName="gap-0 p-0"
    >
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[1fr_auto] gap-5 p-4 sm:p-6">
        <div className="grid min-h-0 grid-rows-[auto_1fr] gap-3">
          <h1 className="t-h2">Paste something worth hearing</h1>
          <Textarea
            value={draft.markdown}
            onChange={(event) => setDraft({ markdown: event.target.value })}
            placeholder="Paste or write here. Markdown is fine."
            spellCheck={false}
            className="h-full min-h-[14rem] resize-none rounded-lg p-4 text-[0.95rem] leading-[1.68]"
          />
        </div>

        <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
          <p className="t-meta">
            {tooShort ? "A paragraph or two is enough to start." : `${draft.voice.name} (${VOICE_PROVIDER_LABEL[draft.voice.provider]}) will read this.`}
            {draft.markdown && !storageUnavailable ? <span className="ml-2">Saved on this device.</span> : null}
          </p>
          <Button
            type="button"
            size="lg"
            onClick={create}
            disabled={tooShort || submitting}
            className="h-10 w-full gap-2 rounded-full px-6 sm:w-auto"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
            Start Narration
          </Button>
        </div>
      </div>

      {Object.entries(workspace.drafts).some(([id, saved]) => id !== draftId && saved.markdown?.trim()) ? (
        <section className="grid gap-2 border-t border-border p-4 sm:p-6">
          <h2 className="t-label">Saved drafts on this device</h2>
          {Object.entries(workspace.drafts).filter(([id, saved]) => id !== draftId && saved.markdown?.trim()).map(([id, saved]) => (
            <Link key={id} href={`/studio?draft=${encodeURIComponent(id)}`} className="truncate rounded-md px-3 py-2 text-sm hover:bg-muted">
              {saved.markdown?.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 100) || "Untitled draft"}
            </Link>
          ))}
        </section>
      ) : null}
      {history.length === 0 ? null : (
        <section className="grid min-w-0 gap-2 border-t border-border p-4 sm:p-6">
          <h2 className="item-label-lockup t-label">
            <Clock size={14} strokeWidth={2} />
            <span>Recent</span>
          </h2>
          <div className="grid max-h-64 gap-0.5 overflow-y-auto">
            {history.slice(0, 20).map((narration) => (
              <HistoryRow key={narration.id} narration={narration} />
            ))}
          </div>
        </section>
      )}
    </WorkbenchPanel>
  );
}
