"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Info,
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
} from "lucide-react";
import { ComposerSettings } from "@/components/studio/composer-settings";
import { NarrationSettings } from "@/components/narration/narration-settings";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { watchNarration } from "@/lib/narrations";
import { useAuth } from "@/lib/auth-context";
import type { Narration } from "@/lib/types";

function NarrationContextPanel({
  id,
  actions,
}: {
  id: string;
  actions?: React.ReactNode;
}) {
  const { user } = useAuth();
  const [narration, setNarration] = useState<Narration | null>(null);

  useEffect(() => {
    setNarration(null);
    return watchNarration(id, setNarration);
  }, [id]);

  return (
    <NarrationSettings
      narration={narration}
      narrationId={id}
      canEdit={narration === null ? user !== null : user !== null && narration.ownerUid === user.uid}
      actions={actions}
    />
  );
}

function QuietPanel() {
  return <WorkbenchPanel bodyClassName="p-4">{null}</WorkbenchPanel>;
}

/**
 * The right column.
 *
 * Mirrors the left rail's docking behavior: when docked, it collapses to a
 * 56px icon rail with an expand toggle in the 44px header and the section icon
 * below; when expanded, it renders the full inspector with a collapse toggle
 * in the header.
 */
export function ContextPanel({
  docked = false,
  onToggleDock,
}: {
  docked?: boolean;
  onToggleDock?: () => void;
}) {
  const pathname = usePathname();
  const isStudio = pathname.startsWith("/studio");
  const isNarration = pathname.startsWith("/narration/");
  const sectionLabel = isStudio ? "Voice" : "Sharing";
  const SectionIcon = isStudio ? SlidersHorizontal : Info;

  if (docked) {
    return (
      <aside
        aria-label="Inspector"
        data-docked="true"
        className="grid h-full min-h-0 grid-rows-[auto_1fr] bg-sidebar"
      >
        <div className="flex h-11 items-center justify-center border-b border-sidebar-border px-2">
          <Tooltip>
            <TooltipTrigger
              onClick={onToggleDock}
              aria-label="Expand panel"
              aria-expanded={false}
              className="inline-flex size-8 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <PanelRightOpen size={16} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent side="left">Expand {sectionLabel.toLowerCase()}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-col items-center gap-1 px-2 py-2">
          <Tooltip>
            <TooltipTrigger
              onClick={onToggleDock}
              aria-label={sectionLabel}
              className="flex h-[30px] w-full items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground transition-colors hover:opacity-90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <SectionIcon size={16} strokeWidth={2} className="flex-none" />
            </TooltipTrigger>
            <TooltipContent side="left">{sectionLabel}</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    );
  }

  const collapseAction =
    onToggleDock === undefined ? null : (
      <Tooltip>
        <TooltipTrigger
          onClick={onToggleDock}
          aria-label="Collapse panel"
          aria-expanded={true}
          className="inline-flex size-7 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          <PanelRightClose size={15} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent side="left">Collapse {sectionLabel.toLowerCase()}</TooltipContent>
      </Tooltip>
    );

  if (isStudio) return <ComposerSettings actions={collapseAction} />;

  if (isNarration) {
    const id = pathname.split("/")[2];
    if (id !== undefined && id.length > 0) {
      return <NarrationContextPanel id={id} actions={collapseAction} />;
    }
  }

  return <QuietPanel />;
}
