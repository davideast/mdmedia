"use client";

import { LocateFixed } from "lucide-react";
import { cn } from "cn";

export interface FollowButtonProps {
  onClick: () => void;
  className?: string;
  label?: string;
}

/**
 * Floating white button that appears when the user scrolls away from
 * the narration playhead, providing a single-click action to jump back
 * and resume hands-free Follow mode.
 */
export function FollowButton({
  onClick,
  className,
  label = "Follow",
}: FollowButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Scroll to current"
      aria-label="Scroll to current and resume follow mode"
      className={cn(
        "pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3.5 py-1.5 text-xs font-semibold text-neutral-900 shadow-[0_4px_20px_rgba(0,0,0,0.22)] transition-all hover:bg-neutral-50 active:scale-95 animate-in fade-in slide-in-from-bottom-2 duration-200 cursor-pointer select-none",
        className,
      )}
    >
      <LocateFixed size={13} strokeWidth={2.2} className="text-neutral-700" />
      <span>{label}</span>
    </button>
  );
}
