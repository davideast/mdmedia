"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { currentIdToken } from "@/lib/firebase";

type Step =
  | { kind: "enter" }
  | { kind: "checking" }
  | { kind: "review"; clientName: string }
  | { kind: "done"; approved: boolean }
  | { kind: "error"; message: string };

async function call(path: string, init?: RequestInit) {
  const token = await currentIdToken();
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "Something went wrong.");
  return body;
}

/**
 * Approves a local client (the mdmedia CLI, a coding agent) that asked to act
 * on your behalf. Approving issues it a key that can create and read your
 * private narrations; Settings lists and revokes connected apps.
 */
function ConnectApproval() {
  const initial = useSearchParams().get("code") ?? "";
  const [code, setCode] = useState(initial);
  const [step, setStep] = useState<Step>(initial ? { kind: "checking" } : { kind: "enter" });

  const describe = (value: string): Promise<Step> =>
    call(`/api/v1/device/approve?code=${encodeURIComponent(value)}`)
      .then((pending): Step => ({ kind: "review", clientName: pending.clientName }))
      .catch((error): Step => ({ kind: "error", message: error instanceof Error ? error.message : "That code could not be checked." }));

  const lookUp = (value: string) => {
    setStep({ kind: "checking" });
    void describe(value).then(setStep);
  };

  useEffect(() => {
    // Look the code up once, when the page opens from the link the client printed.
    if (initial) void describe(initial).then(setStep);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve: boolean) => {
    try {
      await call("/api/v1/device/approve", { method: "POST", body: JSON.stringify({ userCode: code, approve }) });
      setStep({ kind: "done", approved: approve });
    } catch (error) {
      setStep({ kind: "error", message: error instanceof Error ? error.message : "That did not go through." });
    }
  };

  return (
    <WorkbenchPanel workspacePage title="Connect app" icon={<KeyRound size={13} strokeWidth={2} />} viewGrid gridVariant="reader">
      <div className="mx-auto grid w-full max-w-md gap-5 pt-10">
        <h1 className="text-[1.15rem] font-semibold text-foreground">Connect an app to your studio</h1>

        {step.kind === "enter" || step.kind === "error" ? (
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void lookUp(code); }}>
            <p className="t-meta">Enter the code your terminal shows, for example after running <code>mdmedia studio login</code>.</p>
            <Label htmlFor="connect-code" className="t-label">Code</Label>
            <Input id="connect-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EFGH"
              autoComplete="off" spellCheck={false} className="font-mono uppercase tracking-widest" />
            {step.kind === "error" ? <p role="alert" className="text-[0.85rem] text-destructive">{step.message}</p> : null}
            <Button type="submit" disabled={!code.trim()}>Continue</Button>
          </form>
        ) : null}

        {step.kind === "checking" ? <p className="t-meta">Checking the code…</p> : null}

        {step.kind === "review" ? (
          <div className="grid gap-4">
            <p className="text-[0.95rem] text-foreground">
              <strong>{step.clientName}</strong> is asking to connect with code <code className="font-mono">{code.toUpperCase()}</code>.
            </p>
            <p className="t-meta">Only continue if you just started this from your own terminal and the code matches.</p>
            <ul className="grid list-disc gap-1 pl-5 text-[0.85rem] text-ink-muted">
              <li>It can create private narrations and images as you, using your Settings.</li>
              <li>It can read permitted narrations and your private images, download results, and upload reference images.</li>
              <li>It can create, edit, and delete your playlists. Deleting a playlist never deletes its narrations.</li>
              <li>It cannot delete, share, or publish narrations, or change your Settings.</li>
            </ul>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void decide(true)}>Allow</Button>
              <Button type="button" variant="outline" onClick={() => void decide(false)}>Deny</Button>
            </div>
          </div>
        ) : null}

        {step.kind === "done" ? (
          <p role="status" className="text-[0.95rem] text-foreground">
            {step.approved
              ? "Connected. You can close this tab and return to your terminal. Revoke it any time in Settings."
              : "Denied. Nothing was connected."}
          </p>
        ) : null}
      </div>
    </WorkbenchPanel>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectApproval />
    </Suspense>
  );
}
