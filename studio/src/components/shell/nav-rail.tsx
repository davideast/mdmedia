"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  AudioLines,
  Library,
  ListMusic,
  ListOrdered,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";
import { useNarration } from "@/components/shell/narration-provider";
import { BrandMark } from "@/components/brand-mark";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Also match nested routes under this href. */
  prefix?: string;
}

const NAV: readonly NavItem[] = [
  { href: "/studio", label: "Studio", icon: AudioLines },
  { href: "/queue", label: "Queue", icon: ListOrdered },
  { href: "/library", label: "Library", icon: Library, prefix: "/narration" },
  { href: "/playlists", label: "Playlists", icon: ListMusic },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  if (pathname.startsWith(`${item.href}/`)) return true;
  if (item.prefix !== undefined && pathname.startsWith(item.prefix)) return true;
  return false;
}

/**
 * The dockable navigation rail.
 *
 * Docked is the default: a 56px icon rail with tooltips and no text, per the
 * brief. Undocking widens it to 248px and reveals the labels. The control is a
 * single icon — it carries no label of its own.
 */
export function NavRail({
  docked,
  onToggleDock,
  onNavigate,
}: {
  docked: boolean;
  onToggleDock: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { generationQueue } = useNarration();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const activeCount = generationQueue.activeCount;

  return (
    <nav
      aria-label="Primary"
      data-docked={docked}
      className="grid h-full min-h-0 grid-rows-[auto_1fr_auto] bg-sidebar"
    >
      <div
        className={cn(
          "flex h-11 items-center border-b border-sidebar-border",
          docked ? "justify-center px-2" : "justify-between gap-2 pl-4 pr-2",
        )}
      >
        {docked ? null : (
          <Link href="/" onClick={onNavigate} className="min-w-0">
            <BrandMark className="text-[0.95rem]" />
          </Link>
        )}
        <Tooltip>
          <TooltipTrigger
            onClick={onToggleDock}
            aria-label={docked ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!docked}
            className="inline-flex size-8 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            {docked ? (
              <PanelLeftOpen size={16} strokeWidth={2} />
            ) : (
              <PanelLeftClose size={16} strokeWidth={2} />
            )}
          </TooltipTrigger>
          <TooltipContent side="right">
            {docked ? "Expand navigation" : "Collapse navigation"}
          </TooltipContent>
        </Tooltip>
      </div>

      <ul className={cn("flex min-h-0 flex-col gap-1 overflow-y-auto py-2", docked ? "px-2" : "px-3")}>
        {NAV.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          const isQueue = item.href === "/queue";
          const showBadge = isQueue && activeCount > 0;

          const link = (
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-[30px] items-center rounded-md text-[13px] transition-colors",
                docked ? "w-full justify-center" : "gap-2 px-2",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-ink-muted hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <div className="relative flex flex-none items-center justify-center">
                <Icon size={16} strokeWidth={2} className="flex-none" />
                {docked && showBadge ? (
                  <span className="absolute -top-1 -right-1 flex size-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                ) : null}
              </div>
              {docked ? null : (
                <>
                  <span className="truncate">{item.label}</span>
                  {showBadge ? (
                    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-semibold text-primary-foreground">
                      {activeCount}
                    </span>
                  ) : null}
                </>
              )}
            </Link>
          );

          const tooltipLabel =
            isQueue && activeCount > 0 ? `${item.label} (${activeCount} active)` : item.label;

          return (
            <li key={item.href}>
              {docked ? (
                <Tooltip>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{tooltipLabel}</TooltipContent>
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>

      <div
        className={cn(
          "grid gap-1 border-t border-sidebar-border py-2",
          docked ? "px-2" : "px-3",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            onClick={() => setTheme(isDark ? "light" : "dark")}
            aria-label="Toggle theme"
            className={cn(
              "flex h-[30px] items-center rounded-md text-[13px] text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
              docked ? "w-full justify-center" : "gap-2 px-2",
            )}
          >
            <Sun size={16} strokeWidth={2} className="hidden flex-none dark:block" />
            <Moon size={16} strokeWidth={2} className="block flex-none dark:hidden" />
            {docked ? null : <span className="truncate">Theme</span>}
          </TooltipTrigger>
          <TooltipContent side="right">Toggle theme</TooltipContent>
        </Tooltip>

        {user === null ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={`/profile/${user.uid}`}
                onClick={onNavigate}
                className={cn(
                  "flex h-[30px] items-center rounded-md text-[13px] text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                  docked ? "w-full justify-center" : "gap-2 px-2",
                )}
              >
                <UserRound size={16} strokeWidth={2} className="flex-none" />
                {docked ? null : <span className="truncate">{user.displayName}</span>}
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">{user.displayName}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </nav>
  );
}
