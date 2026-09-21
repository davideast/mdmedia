"use client";

import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * Panel chrome, ported from the jitro workbench study.
 *
 * Geometry is the study's: a 36px header on the inset plane, a hairline
 * underneath, and a body that scrolls independently of its siblings. The
 * palette is this app's.
 */
export function WorkbenchPanel({
  title,
  titleNode,
  icon,
  actions,
  children,
  headerClassName,
  headerInnerClassName,
  bodyClassName,
  className,
}: {
  title?: string;
  titleNode?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headerClassName?: string;
  headerInnerClassName?: string;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <section className={cn("flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
      {title === undefined && titleNode === undefined ? null : (
        <header
          className={cn(
            "flex h-11 flex-none items-center border-b border-border bg-surface-inset px-3",
            headerClassName,
          )}
        >
          <div
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-1.5",
              headerInnerClassName,
            )}
          >
            <h2 className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold text-foreground">
              {icon}
              {titleNode ?? <span className="truncate">{title}</span>}
            </h2>
            {actions === null || actions === undefined ? null : (
              <div className="flex flex-none items-center gap-1">{actions}</div>
            )}
          </div>
        </header>
      )}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden",
          bodyClassName ?? "gap-2 p-3",
        )}
      >
        {children}
      </div>
    </section>
  );
}
