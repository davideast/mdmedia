"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { highlightCode } from "@/lib/highlight";

export interface CodeBlockProps {
  code: string;
  lang?: string;
  className?: string;
  headerActions?: ReactNode;
  footer?: ReactNode;
}

/**
 * Renders a code snippet with minimal syntax highlighting and a small
 * canonical copy button in the top-right corner.
 */
export function CodeBlock({
  code,
  lang,
  className,
  headerActions,
  footer,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const highlightedHtml = useMemo(() => {
    return highlightCode(code, lang);
  }, [code, lang]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Code copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy code");
    }
  };

  const displayLang = lang?.trim().toLowerCase();

  return (
    <div
      className={cn(
        "group relative grid w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-surface-card shadow-2xs",
        className,
      )}
    >
      {/* Top bar with optional language label and canonical copy button */}
      <div className="flex items-center justify-between border-b border-border/50 px-3.5 py-1.5 bg-surface-inset/40">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint select-none">
          {displayLang && displayLang.length > 0 ? displayLang : "code"}
        </span>

        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={copied ? "Copied" : "Copy code"}
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
              {copied ? "Copied!" : "Copy code"}
            </TooltipContent>
          </Tooltip>
          {headerActions}
        </div>
      </div>

      {/* Code body */}
      <pre className="w-full min-w-0 max-w-full overflow-x-auto p-4 text-[0.85rem] leading-relaxed font-mono whitespace-pre text-foreground">
        <code
          className="font-mono"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>

      {footer}
    </div>
  );
}
