import type { ReactNode } from "react";
import { cn } from "cn";

/** Common grouping for media settings, with the existing Studio label scale. */
export function InspectorSection({ title, children, className }: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("grid min-w-0 gap-3", className)}>
      <legend className="t-label mb-3 text-ink-muted">{title}</legend>
      {children}
    </fieldset>
  );
}
