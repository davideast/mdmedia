"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Check,
  Copy,
  FileText,
  FolderTree,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Volume2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FollowButton } from "@/components/reader/follow-button";
import { TreeDocumentReader } from "@/components/reader/tree-document-reader";
import { useReaderFollow } from "@/components/reader/use-reader-follow";
import type { HeaderAction, HeaderActions } from "@/components/shell/header-action";
import { useNarration } from "@/components/shell/narration-provider";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import {
  TreeProvider,
  useOptionalTreeContext,
  useTreeContext,
} from "@/components/tree/tree-provider";
import { currentIdToken } from "@/lib/firebase";
import { executeMediaRemix } from "@/lib/media-remix";
import {
  observeNarrationDocument,
  projectNarrationView,
  type NarrationDocument,
} from "@/lib/narration-document";
import { watchNarration } from "@/lib/narrations";
import { buildTreeNodeHref, normalizeVirtualPath } from "@/lib/tree-client";
import { resolveTreeNode } from "@/lib/tree-helpers";
import type {
  MediaRemixRequest,
  MediaRemixResult,
} from "@/lib/tree-types";
import type { NarrationTimingsFile } from "@/lib/wav";

function useObservedNarration(narrationId: string | null): NarrationDocument | null {
  const [narrationDoc, setNarrationDoc] = useState<NarrationDocument | null>(
    null,
  );

  useEffect(() => {
    if (!narrationId) {
      return;
    }
    return observeNarrationDocument(
      narrationId,
      {
        watch: watchNarration,
        timings: async (id, signal) => {
          const token = await currentIdToken();
          const response = await fetch(`/api/narrations/${id}/timings?raw=1`, {
            signal,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!response.ok) return null;
          return (await response.json()) as NarrationTimingsFile;
        },
      },
      setNarrationDoc,
    );
  }, [narrationId]);

  return narrationId && narrationDoc?.id === narrationId ? narrationDoc : null;
}

function TreeDocumentSurface() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNewMode = searchParams?.get("new") === "1";
  const isBriefingMode = searchParams?.get("briefing") === "1";
  const folderParam = searchParams?.get("folder") ?? "";

  const {
    tree,
    loadingTree,
    activeNode,
    activeDocument,
    loadingDocument,
    routeResolution,
    startNodeNarration,
    compileSelection,
    toggleSelectNode,
    clearSelection,
    applyOps,
  } = useTreeContext();
  const {
    stream: playback,
    playNarration,
    highlightColor,
    draft,
  } = useNarration();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [startingAudio, setStartingAudio] = useState(false);
  const [copiedDocId, setCopiedDocId] = useState<string | null>(null);
  const [localNarration, setLocalNarration] = useState<{
    nodeId: string;
    narrationId: string;
  } | null>(null);

  const inferredParentFolder = useMemo(() => {
    if (folderParam) return folderParam;
    if (!activeNode) return "";
    if (activeNode.kind === "folder") return activeNode.path;
    const slashIdx = activeNode.path.lastIndexOf("/");
    return slashIdx > 0 ? activeNode.path.slice(0, slashIdx) : "";
  }, [folderParam, activeNode]);

  const [targetFolderOverride, setTargetFolderOverride] = useState<{
    sourceFolder: string;
    value: string;
  } | null>(null);
  const targetFolder =
    targetFolderOverride?.sourceFolder === inferredParentFolder
      ? targetFolderOverride.value
      : inferredParentFolder;
  const setTargetFolder = useCallback(
    (value: string) => {
      setTargetFolderOverride({ sourceFolder: inferredParentFolder, value });
    },
    [inferredParentFolder],
  );
  const [newFileName, setNewFileName] = useState("overview.md");
  const [newDocMarkdown, setNewDocMarkdown] = useState("# Overview\n\n");
  const [creatingDoc, setCreatingDoc] = useState(false);

  const [briefingTitle, setBriefingTitle] = useState("");
  const [briefingInstructions, setBriefingInstructions] = useState("");
  const [saveBriefingToTree, setSaveBriefingToTree] = useState(false);
  const [briefingSavePath, setBriefingSavePath] = useState("briefings/overview-briefing.md");
  const [creatingBriefing, setCreatingBriefing] = useState(false);

  const defaultBriefingTitle = tree ? `${tree.title} Briefing` : "Briefing";
  const effectiveBriefingTitle = briefingTitle || defaultBriefingTitle;

  const selectedDocNodes = useMemo(() => {
    if (!tree) return [];
    return tree.selectedNodeIds
      .map((id) => tree.nodes[id])
      .filter((node): node is NonNullable<typeof node> => Boolean(node && node.kind === "doc"));
  }, [tree]);

  const handleCreateBriefing = useCallback(async () => {
    if (!tree || creatingBriefing || selectedDocNodes.length === 0) return;
    setCreatingBriefing(true);
    try {
      const resolvedTitle = effectiveBriefingTitle.trim() || `${tree.title} Briefing`;
      const trimmedSavePath = saveBriefingToTree ? briefingSavePath.trim() : "";
      const normalizedSavePath = trimmedSavePath
        ? normalizeVirtualPath(
            trimmedSavePath.toLowerCase().endsWith(".md")
              ? trimmedSavePath
              : `${trimmedSavePath}.md`,
          )
        : undefined;
      const result = await compileSelection({
        title: resolvedTitle,
        ...(briefingInstructions.trim()
          ? { instructions: briefingInstructions.trim() }
          : {}),
        ...(normalizedSavePath ? { saveAsPath: normalizedSavePath } : {}),
        narrate: true,
        voice: draft.voice.name,
        voiceProvider: draft.voice.provider,
        voiceId: draft.voice.id,
        promptStyle: draft.promptStyle,
      });
      if (result?.narrationId) {
        playNarration(result.narrationId);
      }
      toast.success(
        normalizedSavePath
          ? `Created briefing at ${normalizedSavePath}`
          : "Started consolidated audio briefing",
      );
      if (result?.savedNode) {
        router.push(buildTreeNodeHref(tree.id, result.savedNode));
      } else if (result?.narrationId) {
        router.push(`/narration/${encodeURIComponent(result.narrationId)}`);
      }
    } catch (error) {
      toast.error(
        (error as Error).message || "Could not create briefing.",
      );
    } finally {
      setCreatingBriefing(false);
    }
  }, [
    tree,
    creatingBriefing,
    selectedDocNodes.length,
    effectiveBriefingTitle,
    saveBriefingToTree,
    briefingSavePath,
    compileSelection,
    briefingInstructions,
    draft.voice.name,
    draft.voice.provider,
    draft.voice.id,
    draft.promptStyle,
    playNarration,
    router,
  ]);

  const resolvedCreatePath = useMemo(() => {
    const cleanFolder = targetFolder.trim().replace(/^\/+|\/+$/g, "");
    const cleanFile = newFileName.trim().replace(/^\/+|\/+$/g, "");
    if (!cleanFile) return "";
    const withExt = cleanFile.toLowerCase().endsWith(".md")
      ? cleanFile
      : `${cleanFile}.md`;
    const combined = cleanFolder ? `${cleanFolder}/${withExt}` : withExt;
    try {
      return normalizeVirtualPath(combined);
    } catch {
      return combined;
    }
  }, [targetFolder, newFileName]);

  const handleCreateDocument = useCallback(async () => {
    if (!tree || creatingDoc || !resolvedCreatePath) return;
    setCreatingDoc(true);
    try {
      const normalizedPath = normalizeVirtualPath(resolvedCreatePath);
      const updated = await applyOps([
        {
          op: "put_doc",
          path: normalizedPath,
          markdown: newDocMarkdown,
        },
      ]);
      const createdNode = updated
        ? Object.values(updated.nodes).find(
            (node) => node.kind === "doc" && node.path === normalizedPath,
          )
        : null;
      toast.success(`Created ${normalizedPath}`);
      if (createdNode && updated) {
        router.push(buildTreeNodeHref(updated.id, createdNode));
      } else if (updated) {
        router.push(`/trees/${encodeURIComponent(updated.id)}`);
      }
    } catch (error) {
      toast.error((error as Error).message || "Could not create document.");
    } finally {
      setCreatingDoc(false);
    }
  }, [tree, creatingDoc, resolvedCreatePath, newDocMarkdown, applyOps, router]);

  // Keep browser address bar synced to canonical path after node moves or renames
  useEffect(() => {
    if (isNewMode || isBriefingMode) return;
    const canonicalHref = routeResolution.canonicalHref;
    if (!canonicalHref || typeof window === "undefined") return;
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref !== canonicalHref) {
      window.history.replaceState(null, "", canonicalHref);
    }
  }, [isNewMode, isBriefingMode, routeResolution.canonicalHref]);

  const narrationId =
    (activeNode && localNarration?.nodeId === activeNode.id
      ? localNarration.narrationId
      : null) ??
    activeDocument?.narrationId ??
    activeNode?.narrationId ??
    null;
  const observedNarration = useObservedNarration(narrationId);

  const projectedNarration = useMemo(() => {
    if (!narrationId) return null;
    return projectNarrationView(narrationId, observedNarration, playback);
  }, [narrationId, observedNarration, playback]);

  const words = useMemo(
    () =>
      projectedNarration
        ? projectedNarration.chunks.flatMap((chunk) => chunk.words)
        : [],
    [projectedNarration],
  );

  const spokenThrough = useMemo(() => {
    if (!projectedNarration) return 0;
    if (projectedNarration.status === "ready" && words.length > 0) {
      return Math.max(
        projectedNarration.transcript.length,
        words.reduce((end, word) => Math.max(end, word.charEnd), 0),
      );
    }
    let through = 0;
    for (const chunk of projectedNarration.chunks) {
      through = Math.max(through, chunk.docOffset + chunk.text.length);
    }
    return through;
  }, [projectedNarration, words]);

  const loadedDurationMs = useMemo(() => {
    const wordsMax = words.reduce((end, word) => Math.max(end, word.endMs), 0);
    return Math.max(projectedNarration?.durationMs ?? 0, wordsMax);
  }, [projectedNarration?.durationMs, words]);

  const audioLoaded = Boolean(
    projectedNarration &&
      ((projectedNarration.player !== null &&
        projectedNarration.durationMs > 0) ||
        words.length > 0),
  );

  const isFetchingReadyTimings =
    (activeNode?.narrationStatus === "ready" ||
      activeDocument?.narrationStatus === "ready" ||
      observedNarration?.status === "ready") &&
    words.length === 0;

  const narrationActive =
    !isFetchingReadyTimings &&
    (startingAudio ||
      activeNode?.narrationStatus === "streaming" ||
      activeDocument?.narrationStatus === "streaming" ||
      projectedNarration?.status === "starting" ||
      projectedNarration?.status === "streaming" ||
      Boolean(playback.id !== null && playback.status !== "idle"));

  const isLive = Boolean(narrationId && playback.id === narrationId);
  const isPlaying = Boolean(isLive && playback.playing);
  const isVoiceChanged = Boolean(
    narrationId &&
      observedNarration?.voice &&
      draft.voice.name &&
      observedNarration.voice !== draft.voice.name &&
      localNarration?.narrationId === narrationId,
  );
  const isStale = activeDocument?.narrationStale === true || isVoiceChanged;

  const { showFollowButton, scrollToCurrent } = useReaderFollow({
    containerRef: scrollContainerRef,
    activeCharStart: projectedNarration?.activeWord?.charStart ?? null,
    activeCharEnd: projectedNarration?.activeWord?.charEnd ?? null,
    isPlaying,
    disabled: isNewMode || isBriefingMode || !activeDocument,
  });

  const handlePrimaryAudioAction = useCallback(async () => {
    if (!activeNode || startingAudio) return;
    if (narrationId && !isStale) {
      if (isLive && playback.player && playback.durationMs > 0) {
        if (playback.playing) {
          playback.player.pause();
        } else {
          void playback.player.play();
        }
      } else {
        playNarration(narrationId);
      }
      return;
    }

    setStartingAudio(true);
    try {
      const started = await startNodeNarration(activeNode.id, {
        voice: draft.voice.name,
        voiceProvider: draft.voice.provider,
        voiceId: draft.voice.id,
        promptStyle: draft.promptStyle,
      });
      if (started?.narrationId) {
        setLocalNarration({
          nodeId: activeNode.id,
          narrationId: started.narrationId,
        });
        playNarration(started.narrationId);
        toast.success(
          isStale ? "Regenerated document audio" : "Started document narration",
        );
      }
    } catch (error) {
      toast.error((error as Error).message || "Could not start narration.");
    } finally {
      setStartingAudio(false);
    }
  }, [
    activeNode,
    startingAudio,
    narrationId,
    isStale,
    isLive,
    playback.player,
    playback.durationMs,
    playback.playing,
    playNarration,
    startNodeNarration,
    draft.voice.name,
    draft.voice.provider,
    draft.voice.id,
    draft.promptStyle,
  ]);

  const handleSeekWord = useCallback(
    (startMs: number) => {
      if (!narrationId) {
        void handlePrimaryAudioAction();
        return;
      }
      if (isLive && playback.player && playback.durationMs > 0) {
        playback.player.seek(startMs);
        if (!playback.playing) void playback.player.play();
      } else {
        playNarration(narrationId, startMs);
      }
    },
    [
      narrationId,
      handlePrimaryAudioAction,
      isLive,
      playback.player,
      playback.durationMs,
      playback.playing,
      playNarration,
    ],
  );

  const resolveDocHref = useCallback(
    (rawHref: string): string | null => {
      if (!tree) return null;
      const trimmed = rawHref.trim();
      if (
        !trimmed ||
        trimmed.startsWith("#") ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)
      ) {
        return null;
      }
      if (trimmed.startsWith("/trees/")) return trimmed;

      const hashIdx = trimmed.indexOf("#");
      const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
      const pathPart = (
        hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed
      )
        .split("?")[0]!
        .trim();
      if (!pathPart) return null;

      const currentDocPath = activeDocument?.path ?? activeNode?.path ?? "";
      const baseSegments = currentDocPath
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .filter(Boolean);
      if (baseSegments.length > 0) baseSegments.pop();

      const relStack = [...baseSegments];
      for (const seg of pathPart.replace(/^\/+/, "").split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") relStack.pop();
        else relStack.push(seg);
      }
      const relativeCandidate = relStack.join("/");
      const rootCandidate = pathPart.replace(/^(?:\.\/|\/)+/, "");

      const candidates = pathPart.startsWith("/")
        ? [rootCandidate, relativeCandidate]
        : [relativeCandidate, rootCandidate];

      for (const baseCand of [...candidates]) {
        if (!baseCand) continue;
        const parts = baseCand.split("/").filter(Boolean);
        if (parts.length > 1) {
          candidates.push(parts.slice(1).join("/"));
        }
      }

      for (const candidate of candidates) {
        if (!candidate) continue;
        const resolved = resolveTreeNode(tree, candidate);
        if (resolved && resolved.node.kind === "doc") {
          return `${buildTreeNodeHref(tree.id, resolved.node)}${hash}`;
        }
      }

      const allDocs = Object.values(tree.nodes).filter((n) => n.kind === "doc");
      for (const candidate of candidates) {
        if (!candidate) continue;
        const cleanCand = candidate.replace(/^\/+|\/+$/g, "").toLowerCase();
        const segs = cleanCand.split("/").filter(Boolean);
        if (segs.length >= 2) {
          const suffixWithMd = cleanCand.endsWith(".md")
            ? `/${cleanCand}`
            : `/${cleanCand}.md`;
          const suffixMatch = allDocs.find((n) =>
            `/${n.path.toLowerCase()}`.endsWith(suffixWithMd),
          );
          if (suffixMatch) {
            return `${buildTreeNodeHref(tree.id, suffixMatch)}${hash}`;
          }
        }
      }

      const GENERIC_DOC_NAMES = new Set([
        "index.md",
        "readme.md",
        "lesson.md",
        "classification.md",
        "breakdown.md",
        "review.md",
      ]);
      const basename = rootCandidate.split("/").pop()?.toLowerCase() ?? "";
      if (basename && !GENERIC_DOC_NAMES.has(basename)) {
        const stem = basename.replace(/\.md$/i, "");
        const matchingNode = allDocs.find(
          (n) =>
            n.name.toLowerCase() === basename ||
            n.name.replace(/\.md$/i, "").toLowerCase() === stem,
        );
        if (matchingNode) {
          return `${buildTreeNodeHref(tree.id, matchingNode)}${hash}`;
        }
      }

      return null;
    },
    [tree, activeDocument?.path, activeNode?.path],
  );

  const handleNavigateDocHref = useCallback(
    (resolvedHref: string) => {
      router.push(resolvedHref);
    },
    [router],
  );

  const handleCopyMarkdown = useCallback(async () => {
    if (!activeDocument?.markdown) return;
    try {
      await navigator.clipboard.writeText(activeDocument.markdown);
      setCopiedDocId(activeDocument.id);
      toast.success("Document copied as markdown");
      setTimeout(() => setCopiedDocId(null), 2000);
    } catch {
      toast.error("Could not copy markdown to clipboard.");
    }
  }, [activeDocument]);

  const handleRemixMedia = useCallback(
    async (request: MediaRemixRequest): Promise<MediaRemixResult> => {
      if (!activeNode) {
        throw new Error("No active document node.");
      }
      return executeMediaRemix(request, {
        nodeId: activeNode.id,
        markdown: activeDocument?.markdown,
        applyReplaceOp: async (op) => {
          await applyOps([op]);
        },
      });
    },
    [activeNode, activeDocument?.markdown, applyOps],
  );

  const displayTitle = isBriefingMode
    ? "Create briefing"
    : isNewMode
      ? "New document"
      : activeDocument?.title ||
        activeNode?.name.replace(/\.md$/i, "") ||
        tree?.title ||
        "Document";

  const copied = Boolean(activeDocument && copiedDocId === activeDocument.id);

  const headerActions = useMemo<HeaderActions | undefined>(() => {
    if (isNewMode || isBriefingMode || !activeNode || activeNode.kind !== "doc") return undefined;
    const primaryAction: HeaderAction = {
      icon: isStale
        ? RefreshCw
        : isPlaying
          ? Pause
          : narrationId
            ? Play
            : Volume2,
      label: isStale
        ? "Regenerate audio"
        : isPlaying
          ? `Pause ${displayTitle}`
          : narrationId
            ? `Play ${displayTitle}`
            : `Listen to ${displayTitle}`,
      onClick: () => void handlePrimaryAudioAction(),
      disabled: startingAudio,
      emphasis: "primary",
    };
    if (activeDocument?.markdown) {
      const copyAction: HeaderAction = {
        icon: copied ? Check : Copy,
        label: copied ? "Copied markdown" : "Copy as markdown",
        onClick: () => void handleCopyMarkdown(),
      };
      return [primaryAction, copyAction];
    }
    return [primaryAction];
  }, [
    isNewMode,
    isBriefingMode,
    activeNode,
    isStale,
    isPlaying,
    narrationId,
    displayTitle,
    startingAudio,
    activeDocument?.markdown,
    copied,
    handlePrimaryAudioAction,
    handleCopyMarkdown,
  ]);

  const showNewComposer =
    !isBriefingMode &&
    (isNewMode || Boolean(tree && !loadingTree && tree.docCount === 0));

  return (
    <WorkbenchPanel
      workspacePage
      title={displayTitle}
      scrollRef={scrollContainerRef}
      floating={
        showFollowButton ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--player-dock-height,6.5rem)+0.75rem)] z-30 flex justify-center px-4">
            <FollowButton onClick={scrollToCurrent} />
          </div>
        ) : null
      }
      icon={<FileText size={13} strokeWidth={2} className="flex-none" />}
      viewGrid
      gridVariant="reader"
      actions={headerActions}
    >
      <div className="grid w-full gap-5 py-6">
        {isBriefingMode && tree ? (
          <div
            className="grid w-full justify-self-center gap-4"
            style={{ inlineSize: "min(100%, 68ch)" }}
          >
            <div className="grid gap-1.5">
              <label
                htmlFor="briefing-title"
                className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted"
              >
                Briefing title
              </label>
              <input
                id="briefing-title"
                value={effectiveBriefingTitle}
                onChange={(event) => setBriefingTitle(event.target.value)}
                placeholder={`${tree.title} Briefing`}
                aria-label="Briefing title"
                className="flex h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-hidden focus:ring-1 focus:ring-ring placeholder:text-ink-faint"
              />
            </div>

            <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
                  Included documents ({selectedDocNodes.length})
                </span>
                {selectedDocNodes.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void clearSelection()}
                    className="rounded-xs px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>

              {selectedDocNodes.length === 0 ? (
                <p className="py-2 text-[13px] text-ink-muted">
                  Select documents or folders in the left sidebar to include them in this briefing.
                </p>
              ) : (
                <div className="grid gap-1">
                  {selectedDocNodes.map((node, index) => (
                    <div
                      key={node.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[12px]"
                    >
                      <span className="font-mono text-[11px] text-ink-faint">
                        {index + 1}.
                      </span>
                      <span className="truncate font-mono text-foreground">
                        {node.path}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${node.path} from briefing`}
                        onClick={() => void toggleSelectNode(node.id)}
                        className="grid size-5 place-items-center rounded-xs text-ink-muted transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-1.5">
              <label
                htmlFor="briefing-instructions"
                className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted"
              >
                Consolidation &amp; narration instructions
              </label>
              <Textarea
                id="briefing-instructions"
                value={briefingInstructions}
                onChange={(event) => setBriefingInstructions(event.target.value)}
                placeholder="Describe how to synthesize and narrate these documents (e.g., 'Create a 5-minute executive walkthrough focusing on storage architecture, failure recovery, and key design trade-offs')..."
                aria-label="Consolidation and narration instructions"
                className="min-h-[9rem] w-full resize-y rounded-lg p-3.5 text-sm leading-relaxed"
              />
            </div>

            <div className="grid gap-2.5 rounded-lg border border-border bg-card p-3">
              <label className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 text-[13px] text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveBriefingToTree}
                  onChange={(event) => setSaveBriefingToTree(event.target.checked)}
                  className="size-4 accent-primary"
                />
                <span>Also save compiled briefing as a document in this tree</span>
              </label>
              {saveBriefingToTree ? (
                <div className="flex h-9 w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs focus-within:ring-1 focus-within:ring-ring">
                  <span className="flex-none text-ink-muted">{tree.title} /</span>
                  <input
                    value={briefingSavePath}
                    onChange={(event) => setBriefingSavePath(event.target.value)}
                    placeholder="briefings/overview-briefing.md"
                    aria-label="Briefing document path"
                    className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-hidden placeholder:text-ink-faint"
                  />
                </div>
              ) : null}
            </div>

            <div className="grid grid-flow-col items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (activeNode) {
                    router.push(buildTreeNodeHref(tree.id, activeNode));
                  } else {
                    router.push(`/trees/${encodeURIComponent(tree.id)}`);
                  }
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={creatingBriefing || selectedDocNodes.length === 0}
                onClick={() => void handleCreateBriefing()}
                className="rounded-full px-5"
              >
                <Volume2 size={14} strokeWidth={2} />
                {creatingBriefing ? "Creating briefing…" : "Create briefing"}
              </Button>
            </div>
          </div>
        ) : showNewComposer && tree ? (
          <div
            className="grid w-full justify-self-center gap-4"
            style={{ inlineSize: "min(100%, 68ch)" }}
          >
            <div className="flex h-10 w-full items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm focus-within:ring-1 focus-within:ring-ring">
              <FolderTree
                size={14}
                strokeWidth={2}
                className="flex-none text-ink-muted"
              />
              <button
                type="button"
                onClick={() => setTargetFolder("")}
                title="Create at tree root"
                className="flex-none truncate font-medium text-ink-muted transition-colors hover:text-foreground cursor-pointer"
              >
                {tree.title}
              </button>
              <span className="flex-none text-ink-faint">/</span>
              {targetFolder ? (
                <>
                  <button
                    type="button"
                    onClick={() => setTargetFolder("")}
                    title="Clear folder prefix"
                    className="inline-flex flex-none items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-muted/80 cursor-pointer"
                  >
                    <span>{targetFolder}</span>
                    <X size={11} className="text-ink-muted" />
                  </button>
                  <span className="flex-none text-ink-faint">/</span>
                </>
              ) : null}
              <input
                id="doc-filename"
                value={newFileName}
                onChange={(event) => setNewFileName(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Backspace" &&
                    newFileName.length === 0 &&
                    targetFolder
                  ) {
                    setTargetFolder("");
                  }
                }}
                placeholder="untitled.md or folder/document.md"
                aria-label="Document path"
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground outline-hidden placeholder:text-ink-faint"
              />
            </div>

            <Textarea
              id="doc-markdown"
              value={newDocMarkdown}
              onChange={(event) => setNewDocMarkdown(event.target.value)}
              placeholder="# Document title"
              aria-label="Markdown content"
              spellCheck={false}
              className="min-h-[24rem] w-full resize-y rounded-lg p-4 font-mono text-[0.9rem] leading-[1.68]"
            />

            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <p className="t-meta truncate">
                Path:{" "}
                <span className="font-mono text-foreground">
                  {resolvedCreatePath || "untitled.md"}
                </span>
              </p>
              <div className="grid grid-flow-col justify-end gap-2">
                {tree.docCount > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (activeNode) {
                        router.push(buildTreeNodeHref(tree.id, activeNode));
                      } else {
                        router.push(`/trees/${encodeURIComponent(tree.id)}`);
                      }
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button
                  type="button"
                  disabled={creatingDoc || resolvedCreatePath.length === 0}
                  onClick={() => void handleCreateDocument()}
                  className="rounded-full px-5"
                >
                  <Plus size={14} strokeWidth={2} />
                  Create document
                </Button>
              </div>
            </div>
          </div>
        ) : activeDocument ? (
          <TreeDocumentReader
            document={activeDocument}
            pathAssets={tree?.pathAssets ?? {}}
            words={words}
            chunks={projectedNarration?.chunks}
            sourceMap={projectedNarration?.sourceMap}
            activeCharStart={projectedNarration?.activeWord?.charStart ?? null}
            activeCharEnd={projectedNarration?.activeWord?.charEnd ?? null}
            spokenThrough={spokenThrough}
            audioLoaded={audioLoaded}
            loadedDurationMs={loadedDurationMs}
            narrationActive={narrationActive}
            highlightColor={highlightColor}
            onSeekWord={handleSeekWord}
            onRemixMedia={handleRemixMedia}
            resolveDocHref={resolveDocHref}
            onNavigateDocHref={handleNavigateDocHref}
          />
        ) : loadingTree || loadingDocument ? (
          <div
            role="status"
            className="grid place-items-center py-12 text-[13px] text-ink-muted"
          >
            Loading document…
          </div>
        ) : !tree ? (
          <div
            role="status"
            className="grid place-items-center py-12 text-[13px] text-ink-muted"
          >
            Tree not found.
          </div>
        ) : (
          <div
            role="status"
            className="grid place-items-center py-12 text-[13px] text-ink-muted"
          >
            Select a document from the tree to start reading.
          </div>
        )}
      </div>
    </WorkbenchPanel>
  );
}

export default function TreeNodePage() {
  const params = useParams<{ treeId: string; path?: string[] }>();
  const searchParams = useSearchParams();
  const existingContext = useOptionalTreeContext();

  const rawTreeId = params?.treeId ?? "";
  let treeId = rawTreeId;
  try {
    treeId = decodeURIComponent(rawTreeId);
  } catch {
    treeId = rawTreeId;
  }
  const pathSegments = params?.path;
  const nodeParam = searchParams?.get("node") ?? null;

  if (existingContext) {
    return <TreeDocumentSurface />;
  }

  return (
    <TreeProvider
      treeId={treeId}
      pathSegments={pathSegments}
      nodeParam={nodeParam}
    >
      <TreeDocumentSurface />
    </TreeProvider>
  );
}
