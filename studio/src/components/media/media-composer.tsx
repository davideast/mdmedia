"use client";

import type { ComponentProps, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function MediaIconAction({ label, compact = false, children, className = "", ...props }: ComponentProps<"button"> & { label: string; compact?: boolean }) {
  return <Tooltip><TooltipTrigger asChild><button
    type="button"
    aria-label={label}
    className={`inline-flex flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-muted aria-expanded:bg-muted ${compact ? "size-7" : "size-10"} ${className}`}
    {...props}
  >{children}</button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

/** The common prompt-to-result surface. Each medium owns its options and work. */
export function MediaComposer({
  heading, label, value, placeholder, onChange, onSubmit, actionLabel,
  disabled = false, actionDisabled = false, busy = false, grow = true,
  maxLength, footer, children,
}: {
  heading: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  actionLabel: string;
  disabled?: boolean;
  actionDisabled?: boolean;
  busy?: boolean;
  grow?: boolean;
  maxLength?: number;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`grid min-h-0 min-w-0 grid-rows-[1fr_auto] gap-5 p-4 sm:p-6 ${grow ? "flex-1" : "shrink-0"}`}>
      <div className="grid min-h-0 grid-rows-[auto_1fr] gap-3">
        <h1 className="t-h2">{heading}</h1>
        <Textarea
          aria-label={label}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          spellCheck={false}
          className="h-full min-h-[14rem] resize-none rounded-lg p-4 text-[0.95rem] leading-[1.68]"
        />
        {children}
      </div>
      <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
        <div className="min-w-0">{footer}</div>
        <Button
          type="button"
          size="lg"
          onClick={onSubmit}
          disabled={actionDisabled}
          className="h-10 w-full gap-2 rounded-full px-6 sm:w-auto"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
