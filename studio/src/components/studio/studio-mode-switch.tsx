"use client";
import Link from "next/link";
import { cn } from "cn";
import { useWorkspace } from "@/components/shell/workspace-provider";

/** Both creation workflows share the Studio header and navigation. */
export function StudioModeSwitch({ active }: { active: "narration" | "scene" }) {
  const { state } = useWorkspace();
  return (
    <nav aria-label="Studio mode" className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {([
        { mode: "narration", href: "/studio", label: "Narration" },
        { mode: "scene", href: "/studio/scene", label: "Scene" },
      ] as const).map((item) => (
        <Link key={item.mode} href={[...state.tabs].reverse().find(tab => tab.href.split('?')[0] === item.href)?.href ?? item.href} aria-current={active === item.mode ? "page" : undefined}
          className={cn("rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active === item.mode ? "bg-secondary font-medium text-foreground" : "text-ink-muted hover:text-foreground")}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
