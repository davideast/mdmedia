"use client";

import type { ComponentType, ReactNode } from "react";
import { cn } from "cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One action in a page header. Headers take at most two (see `HeaderActions`),
 * and only the page's critical actions belong there, such as Copy and Play on
 * a narration. No status or loading indicators, pins, badges or settings: those
 * go in the right panel or the content. Every action is the same filled 32px
 * circle with a 16px icon, so they read at the same scale; the main one is the
 * inverted fill.
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
      aria-expanded={action.expanded}
      disabled={action.disabled}
      onClick={action.menu ? undefined : action.onClick}
      className={cn(
        HEADER_BUTTON_CLASS,
        action.emphasis === "primary"
          ? "bg-foreground text-background hover:opacity-90"
          : "bg-foreground/12 text-foreground hover:bg-foreground/20 aria-expanded:bg-foreground/20",
      )}
    >
      <Icon size={HEADER_ICON_SIZE} strokeWidth={2} className={action.iconClassName} />
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
