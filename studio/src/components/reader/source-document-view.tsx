"use client";

import { useMemo, useState } from "react";
import { marked } from "marked";
import { cn } from "cn";
import { Code2, FileText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/reader/code-block";

export interface SourceDocumentViewProps {
  sourceMarkdown: string;
  onSwitchToAdapted?: () => void;
  className?: string;
}

type RenderSegment =
  | { type: "html"; key: string; html: string }
  | { type: "code"; key: string; text: string; lang?: string };

/**
 * Displays the original unadapted source document provided by the user.
 * Allows toggling between rendered markdown and raw markdown text.
 */
export function SourceDocumentView({
  sourceMarkdown,
  onSwitchToAdapted,
  className,
}: SourceDocumentViewProps) {
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");

  const segments = useMemo<RenderSegment[]>(() => {
    if (!sourceMarkdown || sourceMarkdown.trim().length === 0) {
      return [];
    }
    try {
      const tokens = marked.lexer(sourceMarkdown);
      const result: RenderSegment[] = [];
      let pendingTokens: Parameters<typeof marked.parser>[0] = [];
      let counter = 0;

      for (const token of tokens) {
        if (token.type === "code") {
          if (pendingTokens.length > 0) {
            result.push({
              type: "html",
              key: `html_${counter++}`,
              html: marked.parser(pendingTokens),
            });
            pendingTokens = [];
          }
          result.push({
            type: "code",
            key: `code_${counter++}`,
            text: token.text,
            lang: token.lang,
          });
        } else {
          pendingTokens.push(token);
        }
      }

      if (pendingTokens.length > 0) {
        result.push({
          type: "html",
          key: `html_${counter++}`,
          html: marked.parser(pendingTokens),
        });
      }

      return result;
    } catch {
      return [
        {
          type: "html",
          key: "fallback",
          html: marked.parse(sourceMarkdown, { gfm: true, breaks: true }) as string,
        },
      ];
    }
  }, [sourceMarkdown]);

  const isEmpty = !sourceMarkdown || sourceMarkdown.trim().length === 0;

  return (
    <article
      className={cn(
        "mx-auto flex w-full max-w-[68ch] min-w-0 flex-col gap-6 text-[1.0625rem] leading-[1.68] text-foreground",
        className,
      )}
    >
      {/* Informative banner & toolbar */}
      <div className="flex w-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-card/60 p-4 shadow-2xs backdrop-blur-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-6 flex-none items-center justify-center rounded-md bg-muted text-ink-muted">
              <FileText size={14} strokeWidth={2} />
            </span>
            <div>
              <h2 className="text-[0.875rem] font-semibold text-foreground">
                Original source document
              </h2>
              <p className="text-[0.75rem] text-ink-muted">
                This narration was adapted for the ear. You are viewing the original input.
              </p>
            </div>
          </div>

          {onSwitchToAdapted ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSwitchToAdapted}
              className="gap-1.5 text-xs text-foreground hover:bg-muted"
            >
              <Sparkles size={12} strokeWidth={2} className="text-primary" />
              <span>View audio adapted</span>
            </Button>
          ) : null}
        </div>

        <div className="flex items-center justify-start border-t border-border/60 pt-3">
          {/* Rendered vs Raw toggle */}
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              aria-pressed={viewMode === "rendered"}
              onClick={() => setViewMode("rendered")}
              className={cn(
                "flex items-center gap-1.5 rounded-xs px-2.5 py-1 text-[0.75rem] font-medium transition-all",
                viewMode === "rendered"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-ink-muted hover:text-foreground",
              )}
            >
              <FileText size={12} strokeWidth={2} />
              <span>Rendered</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "raw"}
              onClick={() => setViewMode("raw")}
              className={cn(
                "flex items-center gap-1.5 rounded-xs px-2.5 py-1 text-[0.75rem] font-medium transition-all",
                viewMode === "raw"
                  ? "bg-background text-foreground shadow-2xs"
                  : "text-ink-muted hover:text-foreground",
              )}
            >
              <Code2 size={12} strokeWidth={2} />
              <span>Raw</span>
            </button>
          </div>
        </div>
      </div>

      {/* Document content */}
      {isEmpty ? (
        <p className="py-8 text-center text-[0.95rem] text-ink-muted italic">
          No source markdown is available for this narration.
        </p>
      ) : viewMode === "rendered" ? (
        <div className="flex w-full min-w-0 max-w-full flex-col">
          {segments.map((segment) =>
            segment.type === "code" ? (
              <CodeBlock
                key={segment.key}
                code={segment.text}
                lang={segment.lang}
              />
            ) : (
              <div
                key={segment.key}
                className="source-markdown-body w-full min-w-0 max-w-full"
                dangerouslySetInnerHTML={{ __html: segment.html }}
              />
            ),
          )}
        </div>
      ) : (
        <pre className="w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-card p-5 font-mono text-[0.875rem] leading-relaxed whitespace-pre-wrap text-foreground">
          {sourceMarkdown}
        </pre>
      )}
    </article>
  );
}
