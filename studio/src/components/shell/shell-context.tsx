"use client";

import { createContext, useContext } from "react";

export interface ShellContextValue {
  /** Whether the navigation drawer sheet is open */
  navSheetOpen: boolean;
  /** Open navigation drawer */
  openNav: () => void;
  /** Close navigation drawer */
  closeNav: () => void;
  /** Toggle navigation drawer */
  toggleNav: () => void;
  /** Whether navigation drawer toggle button should be displayed (e.g. mobile) */
  showNavToggle: boolean;

  /** Whether the current route supports a context inspector panel */
  hasContext: boolean;
  /** Whether the context drawer sheet is open */
  contextSheetOpen: boolean;
  /** Open context drawer */
  openContext: () => void;
  /** Close context drawer */
  closeContext: () => void;
  /** Toggle context drawer */
  toggleContext: () => void;
  /** Whether context drawer toggle button should be displayed (e.g. tablet/mobile) */
  showContextToggle: boolean;

  /** Whether the persistent audio player bar is currently visible */
  hasPlayerBar: boolean;

  /** Screen breakpoint flags */
  isMobile: boolean;
  isTablet: boolean;
  isMedium: boolean;
  isDesktop: boolean;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const context = useContext(ShellContext);
  if (!context) {
    throw new Error("useShell must be used within an AppShell");
  }
  return context;
}

export function useOptionalShell(): ShellContextValue | null {
  return useContext(ShellContext);
}
