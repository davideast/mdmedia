"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  FolderOpen,
  Library,
  ListOrdered,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import {useSceneComposer} from "@/components/scene/scene-composer-provider";
import { CreateMenu } from "./create-menu";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";
import { useNarration } from "@/components/shell/narration-provider";
import { BrandMark } from "@/components/brand-mark";
import { useConnectivity } from "@/lib/connectivity";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Also match nested routes under this href. */
  prefix?: string;
}

const NAV: readonly NavItem[] = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/library", label: "Library", icon: Library },
  { href: "/queue", label: "Activity", icon: ListOrdered },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href==='/library'&&['/downloads','/playlists'].includes(pathname))return true;
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
  const offline = useConnectivity() === 'offline';
  const isDark = resolvedTheme === "dark";
  const {activeVideoCount}=useSceneComposer();
  const activeCount = generationQueue.activeCount+activeVideoCount;

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
          offline ? (
            <span className="min-w-0 opacity-50" aria-disabled="true"><BrandMark className="text-[0.95rem]" /></span>
          ) : (
            <Link href="/projects" onClick={onNavigate} className="min-w-0">
              <BrandMark className="text-[0.95rem]" />
            </Link>
          )
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
        <li className="mb-3"><CreateMenu compact={docked}/></li>
        {NAV.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          const isQueue = item.href === "/queue";
          const showBadge = isQueue && activeCount > 0;
          const disabled = offline && item.href !== '/downloads';

          const link = (
            <div
              className={cn(
                "flex h-[30px] items-center rounded-md text-[13px] transition-colors",
                docked ? "w-full justify-center" : "gap-2 px-2",
                disabled && "cursor-not-allowed opacity-40",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-ink-muted hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <div className="relative flex flex-none items-center justify-center">
                <Icon size={16} strokeWidth={2} className="flex-none" />
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
            </div>
          );

          const itemControl = disabled ? (
            <div aria-disabled="true" title={`${item.label} requires Studio connection`}>{link}</div>
          ) : (
            <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}>{link}</Link>
          );

          const tooltipLabel =
            isQueue && activeCount > 0 ? `${item.label} (${activeCount} active)` : item.label;

          return (
            <li key={item.href}>
              {docked && !disabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>{itemControl}</TooltipTrigger>
                  <TooltipContent side="right">{tooltipLabel}</TooltipContent>
                </Tooltip>
              ) : (
                itemControl
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

        {user === null ? null : offline ? (
          <div aria-disabled="true" title="Profile requires Studio connection" className={cn(
            "flex h-[30px] cursor-not-allowed items-center rounded-md text-[13px] text-ink-muted opacity-40",
            docked ? "w-full justify-center" : "gap-2 px-2",
          )}>
            <UserRound size={16} strokeWidth={2} />
            {docked ? null : <span className="truncate">{user.displayName}</span>}
          </div>
        ) : (
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
