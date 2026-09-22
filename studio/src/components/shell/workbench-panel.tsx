"use client";

import { cn } from "cn";
import type { ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useOptionalShell } from "@/components/shell/shell-context";

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
  viewGrid = false,
  gridVariant = "content",
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
  viewGrid?: boolean;
  gridVariant?: "content" | "wide" | "full" | "reader";
}) {
  const shell = useOptionalShell();

  return (
    <section className={cn("flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
      {title === undefined && titleNode === undefined ? null : (
        <header
          className={cn(
            "h-11 flex-none items-center border-b border-border bg-surface-inset",
            viewGrid
              ? cn(
                  "grid px-0",
                  gridVariant === "wide" && "view-grid-wide",
                  "grid-cols-[[full-start]_minmax(var(--view-gutter,1.5rem),1fr)_[wide-start_content-start]_minmax(0,var(--view-content-max,68ch))_[content-end_wide-end]_minmax(var(--view-gutter,1.5rem),1fr)_[full-end]]",
                )
              : "flex px-3",
            headerClassName,
          )}
        >
          <div
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-1.5",
              viewGrid &&
                (gridVariant === "wide"
                  ? "col-start-[wide-start] col-end-[wide-end]"
                  : gridVariant === "full"
                    ? "col-start-[full-start] col-end-[full-end] px-3"
                    : "col-start-[content-start] col-end-[content-end]"),
              headerInnerClassName,
            )}
          >
            <div className="inline-flex min-w-0 flex-1 items-center gap-1.5">
              {shell?.showNavToggle ? (
                <button
                  type="button"
                  onClick={shell.toggleNav}
                  aria-label={shell.navSheetOpen ? "Close navigation" : "Open navigation"}
                  aria-expanded={shell.navSheetOpen}
                  className="inline-flex size-7 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden md:hidden"
                >
                  <PanelLeft size={15} strokeWidth={2} />
                </button>
              ) : null}
              <h2 className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-semibold text-foreground">
                {icon}
                {titleNode ?? <span className="truncate">{title}</span>}
              </h2>
            </div>
            <div className="flex flex-none items-center gap-1">
              {actions}
              {shell?.showContextToggle ? (
                <button
                  type="button"
                  onClick={shell.toggleContext}
                  aria-label={shell.contextSheetOpen ? "Close details" : "Open details"}
                  aria-expanded={shell.contextSheetOpen}
                  className="inline-flex size-7 flex-none items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden lg:hidden"
                >
                  <PanelRight size={15} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </div>
        </header>
      )}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden",
          !viewGrid && "flex flex-col",
          bodyClassName,
        )}
      >
        {viewGrid ? (
          <div className={cn("view-grid", gridVariant === "reader" && "view-grid-reader", gridVariant === "wide" && "view-grid-wide")}>
            <div
              className={cn(
                "view-grid-body",
                gridVariant === "wide" &&
                  "[&>*]:col-start-[wide-start] [&>*]:col-end-[wide-end]",
                gridVariant === "full" &&
                  "[&>*]:col-start-[full-start] [&>*]:col-end-[full-end]",
              )}
            >
              {children}
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
