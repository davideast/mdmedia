"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/shell/app-shell";
import { ContextPanel } from "@/components/shell/context-panel";
import { NarrationProvider } from "@/components/shell/narration-provider";
import { SignInGate } from "@/components/shell/sign-in-gate";
import { useAuth } from "@/lib/auth-context";

/**
 * Gate + shell for every signed-in surface.
 *
 * The shell mounts only once there is a user, so no page below it has to guard
 * against a null account.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid h-dvh place-items-center">
        <Loader2 size={20} className="animate-spin text-ink-faint" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (user === null) return <SignInGate />;

  return (
    <NarrationProvider>
      <AppShell context={<ContextPanel />}>{children}</AppShell>
    </NarrationProvider>
  );
}
