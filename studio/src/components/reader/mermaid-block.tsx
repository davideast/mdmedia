"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { Check, Copy, Code, Eye, AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { highlightCode } from "@/lib/highlight";

export interface MermaidBlockProps {
  code: string;
  className?: string;
}

const DIAGRAM_TYPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:flowchart|graph)\b/i, "Flowchart"],
  [/^sequencediagram\b/i, "Sequence Diagram"],
  [/^statediagram(?:-v2)?\b/i, "State Diagram"],
  [/^classdiagram\b/i, "Class Diagram"],
  [/^erdiagram\b/i, "ER Diagram"],
  [/^gantt\b/i, "Gantt Chart"],
  [/^pie\b/i, "Pie Chart"],
  [/^gitgraph\b/i, "Git Graph"],
];

function detectDiagramType(code: string): string {
  const trimmed = code.trim();
  for (const [pattern, label] of DIAGRAM_TYPE_PATTERNS) {
    if (pattern.test(trimmed)) return label;
  }
  return "Diagram";
}

/**
 * Interactive Mermaid diagram renderer.
 *
 * Dynamically loads Mermaid on client-side with theme awareness (dark/light),
 * provides an instant "Chart / Code" view switcher, canonical copy button,
 * strict security sandbox, and zero-layout-shift error recovery.
 */
export function MermaidBlock({ code, className }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"chart" | "code">("chart");
  const [copied, setCopied] = useState(false);
  const uniqueId = useId().replace(/:/g, "_");

  const diagramType = useMemo(() => detectDiagramType(code), [code]);
  const highlightedCode = useMemo(() => highlightCode(code, "markdown"), [code]);

  useEffect(() => {
    let active = true;

    async function renderMermaid() {
      const cleanCode = code.trim();
      if (!cleanCode) {
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
        const { svg } = await mermaid.render(renderId, cleanCode);

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
      {/* Top action bar — identical across Chart and Code modes */}
      <div className="flex items-center justify-between border-b border-border/50 px-3.5 py-1.5 bg-surface-inset/40">
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
          {/* Switch view mode */}
          {!error ? (
            <button
              type="button"
              onClick={() => setViewMode(viewMode === "chart" ? "code" : "chart")}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border border-border/50 bg-surface-inset text-ink-muted hover:border-border-strong hover:text-foreground transition-colors"
              title={viewMode === "chart" ? "View Mermaid source code" : "View rendered chart"}
            >
              {viewMode === "chart" ? (
                <>
                  <Code size={12} />
                  <span>Code</span>
                </>
              ) : (
                <>
                  <Eye size={12} />
                  <span>Chart</span>
                </>
              )}
            </button>
          ) : null}

          {/* Canonical copy button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={copied ? "Copied" : "Copy diagram source"}
                onClick={handleCopy}
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-md border transition-all",
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
    </div>
  );
}
