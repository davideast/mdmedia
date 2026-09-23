"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  Check,
  Copy,
  Code,
  Eye,
  AlertCircle,
  RefreshCw,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Scan,
  X,
} from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { highlightCode } from "@/lib/highlight";

export interface MermaidBlockProps {
  code: string;
  className?: string;
}

const DIAGRAM_TYPE_MAP: Record<string, string> = {
  flowchart: "Flowchart",
  graph: "Flowchart",
  sequencediagram: "Sequence Diagram",
  statediagram: "State Diagram",
  "statediagram-v2": "State Diagram",
  classdiagram: "Class Diagram",
  erdiagram: "ER Diagram",
  gantt: "Gantt Chart",
  pie: "Pie Chart",
  gitgraph: "Git Graph",
};

function detectDiagramType(code: string): string {
  const trimmed = code.trim().toLowerCase();
  for (const [key, label] of Object.entries(DIAGRAM_TYPE_MAP)) {
    if (trimmed.startsWith(key)) return label;
  }
  return "Diagram";
}

/**
 * Interactive Mermaid diagram renderer.
 *
 * Dynamically loads Mermaid on client-side with theme awareness (dark/light),
 * provides an instant segmented "Chart / Code" view switcher, full-screen lightbox
 * modal with zoom/pan controls, canonical copy button, strict security sandbox,
 * and zero-layout-shift error recovery.
 */
export function MermaidBlock({ code, className }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"chart" | "code">("chart");
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [diagramDimensions, setDiagramDimensions] = useState<{ width: number; height: number } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStateRef = useRef<{
    initialDist: number;
    initialZoom: number;
    initialPan: { x: number; y: number };
    focalX: number;
    focalY: number;
  } | null>(null);

  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;
  const panRef = useRef(pan);
  panRef.current = pan;

  const uniqueId = useId().replace(/:/g, "_");

  const diagramType = useMemo(() => detectDiagramType(code), [code]);
  const highlightedCode = useMemo(() => highlightCode(code, "markdown"), [code]);

  const fitToScreen = useCallback(() => {
    if (!canvasRef.current || !svgContainerRef.current) return;
    const svg = svgContainerRef.current.querySelector("svg");
    if (!svg) return;

    let w = 0;
    let h = 0;

    const viewBoxAttr = svg.getAttribute("viewBox");
    if (viewBoxAttr) {
      const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        w = parts[2];
        h = parts[3];
      }
    }

    if (!w || !h) {
      const bbox = svg.getBBox?.();
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        w = bbox.width;
        h = bbox.height;
      }
    }

    if (!w || !h) {
      const rect = svg.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
    }

    if (w > 0 && h > 0) {
      setDiagramDimensions({ width: w, height: h });
      const containerRect = canvasRef.current.getBoundingClientRect();
      const padding = 80;
      const availW = Math.max(containerRect.width - padding, 100);
      const availH = Math.max(containerRect.height - padding, 100);

      const scaleW = availW / w;
      const scaleH = availH / h;
      const fitScale = Math.min(scaleW, scaleH);
      const clampedScale = Math.min(Math.max(+fitScale.toFixed(2), 0.15), 2.5);

      setZoomLevel(clampedScale);
      setPan({ x: 0, y: 0 });
    }
  }, []);

  useEffect(() => {
    if (!lightboxOpen) return;
    const timer = setTimeout(() => {
      fitToScreen();
    }, 60);

    const handleResize = () => fitToScreen();
    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
    };
  }, [lightboxOpen, fitToScreen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !lightboxOpen) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpad or Ctrl/Cmd + wheel centered at cursor
        const zoomDelta = -e.deltaY * 0.01;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - (rect.left + rect.width / 2);
        const mouseY = e.clientY - (rect.top + rect.height / 2);

        const currentZoom = zoomRef.current;
        const currentPan = panRef.current;
        const factor = Math.exp(zoomDelta);
        const nextZoom = Math.min(4, Math.max(0.15, +(currentZoom * factor).toFixed(3)));

        if (nextZoom !== currentZoom && currentZoom > 0) {
          const ptX = (mouseX - currentPan.x) / currentZoom;
          const ptY = (mouseY - currentPan.y) / currentZoom;
          const nextPanX = +(mouseX - ptX * nextZoom).toFixed(1);
          const nextPanY = +(mouseY - ptY * nextZoom).toFixed(1);

          setZoomLevel(nextZoom);
          setPan({ x: nextPanX, y: nextPanY });
        }
      } else {
        // 2-finger trackpad scroll or standard wheel pan
        setPan((prev) => ({
          x: +(prev.x - e.deltaX).toFixed(1),
          y: +(prev.y - e.deltaY).toFixed(1),
        }));
      }
    };

    let gestureStartZoom = 1;
    let gestureStartPan = { x: 0, y: 0 };
    let gestureFocalPoint = { x: 0, y: 0 };

    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const ge = e as unknown as { clientX?: number; clientY?: number };
      gestureStartZoom = zoomRef.current;
      gestureStartPan = { ...panRef.current };
      const rect = canvas.getBoundingClientRect();
      gestureFocalPoint = {
        x: (ge.clientX ?? (rect.left + rect.width / 2)) - (rect.left + rect.width / 2),
        y: (ge.clientY ?? (rect.top + rect.height / 2)) - (rect.top + rect.height / 2),
      };
    };

    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const ge = e as unknown as { scale?: number };
      const scale = ge.scale ?? 1;
      const nextZoom = Math.min(4, Math.max(0.15, +(gestureStartZoom * scale).toFixed(3)));
      if (gestureStartZoom > 0) {
        const ptX = (gestureFocalPoint.x - gestureStartPan.x) / gestureStartZoom;
        const ptY = (gestureFocalPoint.y - gestureStartPan.y) / gestureStartZoom;
        setZoomLevel(nextZoom);
        setPan({
          x: +(gestureFocalPoint.x - ptX * nextZoom).toFixed(1),
          y: +(gestureFocalPoint.y - ptY * nextZoom).toFixed(1),
        });
      }
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("gesturestart", handleGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", handleGestureChange, { passive: false });
    canvas.addEventListener("gestureend", handleGestureEnd, { passive: false });

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("gesturestart", handleGestureStart);
      canvas.removeEventListener("gesturechange", handleGestureChange);
      canvas.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [lightboxOpen]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 1) {
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
    } else if (activePointersRef.current.size === 2) {
      setIsDragging(false);
      const points = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const midX = (points[0].x + points[1].x) / 2;
      const midY = (points[0].y + points[1].y) / 2;
      const rect = canvasRef.current?.getBoundingClientRect();
      const focalX = rect ? midX - (rect.left + rect.width / 2) : 0;
      const focalY = rect ? midY - (rect.top + rect.height / 2) : 0;

      pinchStateRef.current = {
        initialDist: Math.max(dist, 10),
        initialZoom: zoomRef.current,
        initialPan: { ...panRef.current },
        focalX,
        focalY,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 1 && isDragging && dragStartRef.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setPan({
        x: +(dragStartRef.current.panX + dx).toFixed(1),
        y: +(dragStartRef.current.panY + dy).toFixed(1),
      });
    } else if (activePointersRef.current.size === 2 && pinchStateRef.current) {
      const points = Array.from(activePointersRef.current.values());
      const currentDist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const scale = currentDist / pinchStateRef.current.initialDist;
      const nextZoom = Math.min(4, Math.max(0.15, +(pinchStateRef.current.initialZoom * scale).toFixed(3)));

      const { focalX, focalY, initialPan, initialZoom } = pinchStateRef.current;
      if (initialZoom > 0) {
        const ptX = (focalX - initialPan.x) / initialZoom;
        const ptY = (focalY - initialPan.y) / initialZoom;
        setZoomLevel(nextZoom);
        setPan({
          x: +(focalX - ptX * nextZoom).toFixed(1),
          y: +(focalY - ptY * nextZoom).toFixed(1),
        });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignored
    }

    if (activePointersRef.current.size === 0) {
      setIsDragging(false);
      dragStartRef.current = null;
      pinchStateRef.current = null;
    } else if (activePointersRef.current.size === 1) {
      pinchStateRef.current = null;
      const remainingPoint = activePointersRef.current.values().next().value;
      if (remainingPoint) {
        setIsDragging(true);
        dragStartRef.current = {
          x: remainingPoint.x,
          y: remainingPoint.y,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
      }
    }
  };

  const handleZoomIn = () => setZoomLevel((z) => Math.min(4, +(z + 0.15).toFixed(2)));
  const handleZoomOut = () => setZoomLevel((z) => Math.max(0.15, +(z - 0.15).toFixed(2)));
  const handleReset100 = () => {
    setZoomLevel(1);
    setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    let active = true;

    async function renderMermaid() {
      const trimmed = code.trim();
      if (!trimmed) {
        if (active) {
          setSvgHtml(null);
          setLoading(false);
        }
        return;
      }

      setLoading(true);
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          securityLevel: "strict",
          fontFamily: "var(--font-sans), system-ui, sans-serif",
        });

        const renderId = `mmd_${uniqueId}_${Math.random().toString(36).slice(2, 7)}`;
        const { svg } = await mermaid.render(renderId, trimmed);

        if (active) {
          setSvgHtml(svg);
          setError(null);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const message = err instanceof Error ? err.message : "Invalid diagram syntax";
          setError(message);
          setSvgHtml(null);
          setLoading(false);
        }
      }
    }

    void renderMermaid();

    return () => {
      active = false;
    };
  }, [code, resolvedTheme, uniqueId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Diagram source copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy diagram source");
    }
  };


  return (
    <div
      className={cn(
        "group relative my-4 w-full min-w-0 max-w-full rounded-lg border border-border bg-surface-card shadow-2xs transition-colors",
        className,
      )}
    >
      {/* Top action bar — rock-solid layout across Chart and Code modes */}
      <div className="flex h-9 items-center justify-between border-b border-border/50 px-3.5 bg-surface-inset/40">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint select-none">
            {diagramType}
          </span>
          {error ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-destructive">
              <AlertCircle size={11} />
              <span>syntax error</span>
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Segmented view switch (Chart | Code) */}
          {!error ? (
            <div className="inline-flex items-center rounded-md border border-border/60 bg-surface-inset/60 p-0.5 text-xs font-mono">
              <button
                type="button"
                onClick={() => setViewMode("chart")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer",
                  viewMode === "chart"
                    ? "bg-surface-card text-foreground shadow-2xs"
                    : "text-ink-muted hover:text-foreground",
                )}
                title="View rendered chart"
              >
                <Eye size={12} />
                <span>Chart</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("code")}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer",
                  viewMode === "code"
                    ? "bg-surface-card text-foreground shadow-2xs"
                    : "text-ink-muted hover:text-foreground",
                )}
                title="View Mermaid source code"
              >
                <Code size={12} />
                <span>Code</span>
              </button>
            </div>
          ) : null}

          {/* Fullscreen Lightbox button */}
          {!error && svgHtml ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Open full screen lightbox"
                  onClick={() => {
                    setZoomLevel(1);
                    setLightboxOpen(true);
                  }}
                  className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-surface-inset/80 text-ink-muted hover:border-border-strong hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden transition-all cursor-pointer"
                >
                  <Maximize2 size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Full screen view</TooltipContent>
            </Tooltip>
          ) : null}

          {/* Canonical copy button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={copied ? "Copied" : "Copy diagram source"}
                onClick={handleCopy}
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-md border transition-all cursor-pointer",
                  copied
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/60 bg-surface-inset/80 text-ink-muted hover:border-border-strong hover:bg-muted hover:text-foreground",
                  "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
                )}
              >
                {copied ? (
                  <Check size={12} strokeWidth={2.5} className="text-primary" />
                ) : (
                  <Copy size={12} strokeWidth={2} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {copied ? "Copied!" : "Copy diagram source"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Body: Chart View, Code View, or Error Fallback */}
      {error || viewMode === "code" ? (
        <div className="flex flex-col">
          {error ? (
            <div className="px-4 py-2 text-[0.78rem] font-mono text-destructive bg-destructive/10 border-b border-border/50">
              {error}
            </div>
          ) : null}
          <pre className="w-full min-w-0 max-w-full overflow-x-auto p-4 text-[0.85rem] leading-relaxed font-mono whitespace-pre text-foreground">
            <code
              className="font-mono"
              dangerouslySetInnerHTML={{ __html: highlightedCode }}
            />
          </pre>
        </div>
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-x-auto p-4 sm:p-6 flex justify-center items-center min-h-[160px]">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-xs font-mono text-ink-faint">
              <RefreshCw size={13} className="animate-spin text-ink-faint" />
              <span>Rendering diagram...</span>
            </div>
          ) : svgHtml ? (
            <div
              className="mermaid-svg-container flex justify-center items-center w-full [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:mx-auto"
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          ) : null}
        </div>
      )}

      {/* Lightbox / Full Screen Modal */}
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent
          showCloseButton={false}
          overlayClassName="bg-black/90 backdrop-blur-md"
          className="gap-0 fixed inset-0 z-50 flex h-dvh w-dvw max-h-none max-w-none top-0 left-0 translate-x-0 translate-y-0 flex-col rounded-none border-0 bg-background p-0 shadow-none duration-150 outline-none select-none sm:max-w-none"
        >
          {/* Lightbox Top Header Toolbar */}
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4 bg-surface-card select-none z-10">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
                {diagramType}
              </span>
              <span className="text-xs text-ink-faint">Canvas</span>
            </div>

            <div className="flex items-center gap-2">
              {/* Zoom & Pan Controls */}
              <div className="flex items-center gap-1 rounded-md border border-border/70 bg-surface-inset px-1 py-0.5 text-xs font-mono">
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={zoomLevel <= 0.15}
                  title="Zoom Out (-)"
                  className="inline-flex size-6 items-center justify-center rounded text-ink-muted hover:text-foreground disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                >
                  <ZoomOut size={13} />
                </button>
                <span className="px-1.5 text-[11px] font-medium text-foreground tabular-nums min-w-[4ch] text-center">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={zoomLevel >= 4}
                  title="Zoom In (+)"
                  className="inline-flex size-6 items-center justify-center rounded text-ink-muted hover:text-foreground disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                >
                  <ZoomIn size={13} />
                </button>

                <div className="h-3.5 w-px bg-border/60 mx-0.5" />

                <button
                  type="button"
                  onClick={fitToScreen}
                  title="Fit chart to screen"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-ink-muted hover:text-foreground hover:bg-muted cursor-pointer"
                >
                  <Scan size={12} />
                  <span>Fit</span>
                </button>

                <button
                  type="button"
                  onClick={handleReset100}
                  title="Reset to 100%"
                  className="px-1.5 py-0.5 rounded text-[11px] font-medium text-ink-muted hover:text-foreground hover:bg-muted cursor-pointer"
                >
                  100%
                </button>

                <button
                  type="button"
                  onClick={fitToScreen}
                  title="Reset view (Fit to screen)"
                  className="inline-flex size-6 items-center justify-center rounded text-ink-muted hover:text-foreground cursor-pointer"
                >
                  <RotateCcw size={12} />
                </button>
              </div>

              {/* Copy Source */}
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-surface-inset px-2.5 text-xs font-medium text-ink-muted hover:border-border-strong hover:bg-muted hover:text-foreground transition-all cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check size={12} strokeWidth={2.5} className="text-primary" />
                    <span className="text-primary">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} strokeWidth={2} />
                    <span>Copy</span>
                  </>
                )}
              </button>

              {/* Close Button */}
              <button
                type="button"
                onClick={() => setLightboxOpen(false)}
                className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-surface-inset text-ink-muted hover:border-border-strong hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
                title="Close (Esc)"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <DialogTitle className="sr-only">{diagramType} Full Screen View</DialogTitle>

          {/* Lightbox Canvas Area with Pan/Zoom Canvas */}
          <div
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className={cn(
              "relative flex-1 w-full overflow-hidden select-none touch-none",
              "flex items-center justify-center",
              "bg-surface-page",
              "bg-[radial-gradient(var(--border)_1px,transparent_1px)]",
              isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
            style={{
              backgroundSize: `${Math.round(24 * zoomLevel)}px ${Math.round(24 * zoomLevel)}px`,
              backgroundPosition: `calc(50% + ${pan.x}px) calc(50% + ${pan.y}px)`,
            }}
          >
            {svgHtml ? (
              <div
                ref={svgContainerRef}
                className={cn(
                  "flex items-center justify-center shrink-0",
                  "[&>svg]:!max-w-none [&>svg]:!w-full [&>svg]:!h-full [&>svg]:overflow-visible",
                  isDragging ? "transition-none" : "transition-transform duration-100 ease-out",
                )}
                style={{
                  width: diagramDimensions ? `${diagramDimensions.width}px` : "auto",
                  height: diagramDimensions ? `${diagramDimensions.height}px` : "auto",
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoomLevel})`,
                  transformOrigin: "center center",
                }}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            ) : null}

            {/* Bottom-center floating navigation hint */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none rounded-full border border-border/60 bg-surface-card/90 px-3.5 py-1 text-[11px] font-mono text-ink-muted shadow-xs backdrop-blur-md select-none">
              Drag to pan · Scroll to move · Pinch or ± to zoom
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
