"use client";

import { useMemo } from "react";
import { marked } from "marked";
import { cn } from "cn";
import { CodeBlock } from "@/components/reader/code-block";
import { MermaidBlock } from "@/components/reader/mermaid-block";

export interface SourceDocumentViewProps {
  sourceMarkdown: string;
  viewMode?: "source" | "raw" | "rendered";
  className?: string;
}

type RenderSegment =
  | { type: "html"; key: string; html: string }
  | { type: "code"; key: string; text: string; lang?: string };

/**
 * Displays the original unadapted source document provided by the user.
 * Renders formatted markdown (Source) or raw code (Raw) without banner clutter.
 */
export function SourceDocumentView({
  sourceMarkdown,
  viewMode = "source",
  className,
}: SourceDocumentViewProps) {
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
      {isEmpty ? (
        <p className="py-8 text-center text-[0.95rem] text-ink-muted italic">
          No source markdown is available for this narration.
        </p>
      ) : viewMode === "raw" ? (
        <pre className="w-full min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-card p-5 font-mono text-[0.875rem] leading-relaxed whitespace-pre-wrap text-foreground">
          {sourceMarkdown}
        </pre>
      ) : (
        <div className="flex w-full min-w-0 max-w-full flex-col">
          {segments.map((segment) =>
            segment.type === "code" ? (
              segment.lang?.toLowerCase().trim() === "mermaid" ? (
                <MermaidBlock
                  key={segment.key}
                  code={segment.text}
                />
              ) : (
                <CodeBlock
                  key={segment.key}
                  code={segment.text}
                  lang={segment.lang}
                />
              )
            ) : (
              <div
                key={segment.key}
                className="source-markdown-body w-full min-w-0 max-w-full"
                dangerouslySetInnerHTML={{ __html: segment.html }}
              />
            ),
          )}
        </div>
      )}
    </article>
  );
}
