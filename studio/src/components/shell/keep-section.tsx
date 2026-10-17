"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RetentionPanelFields } from "@/components/studio/retention-control";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";
import type { MediaType } from "@/lib/media-types";
import { isWorkRoute } from "@/lib/workspace-navigation";

/**
 * Whether this work stays around: pinned in the sidebar, and, for media you
 * own, how long it is kept. It lives in the right panel so the page header
 * keeps only its main actions.
 */
export function KeepSection({ media }: { media?: { type: MediaType; id: string } }) {
  const workspace = useOptionalWorkspace();
  const view = workspace?.activeView;
  const pinnable = view !== undefined && view !== null && isWorkRoute(view.href);
  if (!pinnable && !media) return null;

  return (
    <section aria-labelledby="keep-heading" className="grid gap-4">
      <h3 id="keep-heading" className="t-label">Keep</h3>
      {pinnable ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="grid gap-1">
            <Label htmlFor="pin-to-sidebar" className="t-card-title font-normal">Pin to sidebar</Label>
            <p className="t-meta">Keeps it one tap away.</p>
          </div>
          <Switch
            id="pin-to-sidebar"
            checked={view.pinned === true}
            onCheckedChange={() => workspace!.store.togglePin(view.id)}
          />
        </div>
      ) : null}
      {media ? <RetentionPanelFields type={media.type} id={media.id} /> : null}
    </section>
  );
}
