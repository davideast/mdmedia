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
import type { HeaderActions } from "@/components/shell/header-action";
import { KeepSection } from "@/components/shell/keep-section";
import type { MediaType } from "@/lib/media-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { watchNarration } from "@/lib/narrations";
import { useAuth } from "@/lib/auth-context";
import type { Narration } from "@/lib/types";

function NarrationContextPanel({
  id,
  actions,
}: {
  id: string;
  actions?: HeaderActions;
}) {
  const { user } = useAuth();
  const [narration, setNarration] = useState<Narration | null>(null);

  useEffect(() => {
    return watchNarration(id, setNarration);
  }, [id]);

  return (
    <NarrationSettings
      narration={narration}
      narrationId={id}
      canEdit={narration !== null && user !== null && narration.ownerUid === user.uid}
      actions={actions}
    />
  );
}

const MEDIA_ROUTE = /^\/(image|video|music)\/([^/?#]+)/;

/** Pages without their own inspector still get Keep: pinning, and retention for media. */
function WorkPanel({ pathname, actions }: { pathname: string; actions?: HeaderActions }) {
  const match = MEDIA_ROUTE.exec(pathname);
  const media = match ? { type: match[1] as MediaType, id: decodeURIComponent(match[2]!) } : undefined;
  return (
    <WorkbenchPanel title="Details" icon={<Info size={13} strokeWidth={2} />} actions={actions} bodyClassName="gap-6 p-4">
      <KeepSection media={media} />
    </WorkbenchPanel>
  );
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

  const collapseAction: HeaderActions | undefined =
    onToggleDock === undefined
      ? undefined
      : [{ icon: PanelRightClose, label: `Collapse ${sectionLabel.toLowerCase()}`, onClick: onToggleDock, expanded: true }];

  if (isStudio) return <ComposerSettings actions={collapseAction} />;

  if (isNarration) {
    const id = pathname.split("/")[2];
    if (id !== undefined && id.length > 0) {
      return <NarrationContextPanel key={id} id={id} actions={collapseAction} />;
    }
  }

  return <WorkPanel pathname={pathname} actions={collapseAction} />;
}
