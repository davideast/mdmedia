import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Status and action styling shared by generation inspectors. */
export function GenerationAction({ status, label, helper, onAction, disabled, secondary }: {
  status: string;
  label: string;
  helper: string;
  onAction?: () => void;
  disabled?: boolean;
  secondary?: ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t border-border p-4">
      <p role="status" aria-live="polite" className="text-[0.82rem] font-medium text-foreground">{status}</p>
      <Button size="lg" className="h-10 w-full rounded-full" onClick={onAction} disabled={disabled || !onAction}>
        {label}
      </Button>
      <p className="t-meta">{helper}</p>
      {secondary}
    </div>
  );
}
