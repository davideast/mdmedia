"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { useAuth } from "@/lib/auth-context";

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3.01h3.89c2.27-2.09 3.57-5.17 3.57-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.89-3.01c-1.08.72-2.46 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.18 15.23 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.75 12 4.75Z"
      />
    </svg>
  );
}

/**
 * The sign-in surface.
 *
 * Deliberately plain: one account, one button. It says nothing about sessions,
 * identifiers, or how accounts are stored.
 */
export function SignInGate() {
  const { signIn, accessDenied } = useAuth();
  const [working, setWorking] = useState(false);

  const start = async () => {
    setWorking(true);
    try {
      await signIn();
    } catch {
      toast.error("Sign in did not complete. Try again.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="grid h-dvh place-items-center p-8">
      <div className="grid w-full max-w-[26rem] justify-items-center gap-7 text-center">
        <BrandMark className="text-[1.1rem]" />

        <div className="grid gap-3">
          <h1 className="t-section-title text-[2.1rem]">Sign in to mdmedia studio</h1>
          <p className="t-lead mx-auto text-center">
            Your narrations, your voices, and your settings stay with your account.
          </p>
        </div>

        {accessDenied ? (
          <div
            role="alert"
            className="w-full rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--surface-1)] px-4 py-3 text-left text-[0.84rem] text-[color:var(--fg-secondary)]"
          >
            This account is not on the studio allowlist. Sign in with an approved email address or request access from an administrator.
          </div>
        ) : null}

        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={start}
          disabled={working}
          className="h-11 w-full gap-2.5 rounded-full text-[0.9rem]"
        >
          {working ? <Loader2 size={17} className="animate-spin" /> : <GoogleGlyph />}
          Continue with Google
        </Button>

        <p className="t-meta max-w-[34ch]">
          Access is restricted to allowlisted Google accounts.
        </p>
      </div>
    </div>
  );
}
