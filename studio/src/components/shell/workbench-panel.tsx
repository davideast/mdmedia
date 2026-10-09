"use client";

import { PinWorkButton } from "./work-navigation";
import { cn } from "cn";
import { useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useOptionalShell } from "@/components/shell/shell-context";
import { useOptionalWorkspace } from "@/components/shell/workspace-provider";

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
  floating,
  scrollRef,
  headerClassName,
  headerInnerClassName,
  bodyClassName,
  className,
  viewGrid = false,
  gridVariant = "content",
  workspacePage = false,
}: {
  title?: string;
  titleNode?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  floating?: ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
  headerClassName?: string;
  headerInnerClassName?: string;
  bodyClassName?: string;
  className?: string;
  viewGrid?: boolean;
  gridVariant?: "content" | "wide" | "full" | "reader";
  workspacePage?: boolean;
}) {
  const shell = useOptionalShell();
  const workspace = useOptionalWorkspace();
  const tabId = workspacePage ? workspace?.activeView?.id : undefined;
  const store = workspace?.store;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  useImperativeHandle(scrollRef, () => bodyRef.current!, []);

  useEffect(() => {
    if (tabId && title) store?.updateTab(tabId, { title });
  }, [tabId, title, store]);

  useEffect(() => {
    if (!tabId || !store || !bodyRef.current) return;
    const element = bodyRef.current;
    const top = store.getSnapshot().tabs.find((tab) => tab.id === tabId)?.scrollTop ?? 0;
    restored.current = false;
    const restore = () => {
      element.scrollTop = top;
      if (top === 0 || element.scrollHeight - element.clientHeight >= top) { restored.current = true; observer.disconnect(); }
    };
    // Data/markdown often arrives after the panel mounts. Restore after it can actually scroll.
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    restore();
    const stopWaiting = () => { restored.current = true; observer.disconnect(); };
    element.addEventListener("wheel", stopWaiting, { passive: true });
    element.addEventListener("touchstart", stopWaiting, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener("wheel", stopWaiting); element.removeEventListener("touchstart", stopWaiting); };
  }, [tabId, store]);

  return (
    <section className={cn("relative flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
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
              {workspacePage && workspace ? <PinWorkButton /> : null}
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
        ref={bodyRef}
        onScroll={workspacePage ? (event) => { if (tabId && restored.current) store?.updateTab(tabId, { scrollTop: event.currentTarget.scrollTop }); } : undefined}
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
      {floating}
    </section>
  );
}
