"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { currentIdToken } from "@/lib/firebase";

interface ConnectedApp {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const when = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

async function authorized(path: string, init?: RequestInit) {
  const token = await currentIdToken();
  return fetch(path, { ...init, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** Local clients approved through /connect, with a way to cut each one off. */
export function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    authorized("/api/v1/keys")
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const { keys } = await response.json() as { keys: ConnectedApp[] };
        if (live) setApps(keys);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const revoke = async (app: ConnectedApp) => {
    const response = await authorized(`/api/v1/keys/${app.id}`, { method: "DELETE" });
    if (!response.ok) { toast.error("Could not revoke that app. Try again."); return; }
    toast.success(`${app.name} can no longer reach your studio`);
    setApps((current) => current?.filter((item) => item.id !== app.id) ?? null);
  };

  if (failed) return <p className="t-meta">Connected apps could not be loaded.</p>;
  if (apps === null) return <p className="t-meta">Loading…</p>;
  if (apps.length === 0) {
    return <p className="t-meta">None. Run <code>mdmedia studio login</code> in a terminal to connect the CLI or a coding agent.</p>;
  }
  return (
    <ul aria-label="Connected apps" className="grid min-w-0 gap-2">
      {apps.map((app) => (
        <li key={app.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border px-3 py-2">
          <KeyRound size={14} className="text-ink-muted" />
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate text-[0.85rem] text-foreground">{app.name}</span>
            <span className="text-[0.75rem] text-ink-muted">
              Connected {when(app.createdAt)} · {app.lastUsedAt ? `last used ${when(app.lastUsedAt)}` : "not used yet"}
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void revoke(app)} aria-label={`Revoke ${app.name}`}>Revoke</Button>
        </li>
      ))}
    </ul>
  );
}
