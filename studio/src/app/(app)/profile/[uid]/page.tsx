"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkbenchPanel } from "@/components/shell/workbench-panel";
import { useAuth } from "@/lib/auth-context";
import { watchMyNarrations } from "@/lib/narrations";
import type { Narration } from "@/lib/types";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0] ?? "").join("").toUpperCase();
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="t-label">{label}</span>
      <span className="font-display text-[1.6rem] leading-none font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

export default function ProfilePage() {
  const params = useParams<{ uid: string }>();
  const { user, profile, updateProfile } = useAuth();
  const [items, setItems] = useState<Narration[]>([]);

  const isSelf = user !== null && user.uid === params.uid;

  useEffect(() => {
    if (!isSelf || user === null) return;
    return watchMyNarrations(user.uid, setItems);
  }, [isSelf, user]);

  if (!isSelf) {
    return (
      <WorkbenchPanel title="Profile" icon={<UserRound size={13} strokeWidth={2} />} viewGrid>
        <p className="t-lead">This profile is private.</p>
      </WorkbenchPanel>
    );
  }

  const totalMs = items.reduce((sum, item) => sum + item.durationMs, 0);
  const minutes = Math.round(totalMs / 60_000);

  const commit = (patch: { displayName?: string; bio?: string }) => {
    try {
      void updateProfile(patch);
    } catch {
      toast.error("That did not save. Try again.");
    }
  };

  return (
    <WorkbenchPanel
      title="Profile"
      icon={<UserRound size={13} strokeWidth={2} />}
      viewGrid
    >
      <div className="grid gap-8">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-5">
          <Avatar className="size-16">
            <AvatarImage src={user.photoURL} alt="" />
            <AvatarFallback className="font-display text-[1.1rem]">
              {initials(user.displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="grid gap-1">
            <h1 className="t-h2 truncate">{profile?.displayName ?? user.displayName}</h1>
            <p className="t-meta truncate">{user.email}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="name" className="t-label">
              Name
            </Label>
            <Input
              id="name"
              className="h-10"
              defaultValue={profile?.displayName ?? user.displayName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                if (event.target.value !== profile?.displayName) {
                  void commit({ displayName: event.target.value });
                }
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="bio" className="t-label">
              About
            </Label>
            <Input
              id="bio"
              className="h-10"
              defaultValue={profile?.bio ?? ""}
              placeholder="A sentence about what you make."
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                if (event.target.value !== profile?.bio) {
                  void commit({ bio: event.target.value });
                }
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 rounded-lg border border-border p-6 sm:grid-cols-3">
          <Stat label="Narrations" value={String(items.length)} />
          <Stat label="Minutes" value={String(minutes)} />
          <Stat
            label="Public"
            value={String(items.filter((item) => item.visibility === "public").length)}
          />
        </div>
      </div>
    </WorkbenchPanel>
  );
}
