"use client";

import type { ComponentType, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One action in a page header. Headers take at most two (see `HeaderActions`),
 * so only what someone needs on every visit goes there: Play, Copy, a panel
 * toggle. Everything else, such as pinning, retention, sharing and settings,
 * belongs in the right panel.
 */
export interface HeaderAction {
  /** A lucide icon component. Drawn at the header's single icon size. */
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** Names the action for screen readers and the tooltip. */
  label: string;
  onClick?: () => void;
  /** Items for a menu opened by this action, instead of `onClick`. */
  menu?: ReactNode;
  disabled?: boolean;
  /** Shows a spinner in place of the icon while something loads. */
  busy?: boolean;
  /** For toggles: whether the thing it opens is open. */
  expanded?: boolean;
  /** The page's main action is filled; the rest are quiet. */
  emphasis?: "primary";
  /** Extra icon classes, such as a fill for Play, which reads better solid. */
  iconClassName?: string;
}

/** A header holds one or two actions; the last is rightmost. */
export type HeaderActions = readonly [HeaderAction] | readonly [HeaderAction, HeaderAction];

/** The one size every header button uses, so the row stays aligned. */
export const HEADER_BUTTON_CLASS =
  "inline-flex size-8 flex-none items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-40";
export const HEADER_ICON_SIZE = 16;

export function HeaderActionButton({ action }: { action: HeaderAction }) {
  const Icon = action.icon;
  const button = (
    <button
      type="button"
      aria-label={action.label}
      aria-busy={action.busy || undefined}
      aria-expanded={action.expanded}
      disabled={action.disabled}
      onClick={action.menu ? undefined : action.onClick}
      className={cn(
        HEADER_BUTTON_CLASS,
        action.emphasis === "primary"
          ? "bg-foreground text-background hover:opacity-90"
          : "text-ink-muted hover:bg-muted hover:text-foreground aria-expanded:bg-muted",
      )}
    >
      {action.busy ? (
        <Loader2 size={HEADER_ICON_SIZE} strokeWidth={2} className="animate-spin" />
      ) : (
        <Icon size={HEADER_ICON_SIZE} strokeWidth={2} className={action.iconClassName} />
      )}
    </button>
  );

  if (action.menu) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">{action.menu}</DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  );
}
