"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  TreeProvider,
  useOptionalTreeContext,
} from "@/components/tree/tree-provider";

export default function TreeLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ treeId: string }>();
  const existing = useOptionalTreeContext();
  const rawTreeId = params?.treeId ?? "";
  let treeId = rawTreeId;
  try {
    treeId = decodeURIComponent(rawTreeId);
  } catch {
    treeId = rawTreeId;
  }

  if (existing) {
    return <>{children}</>;
  }

  return <TreeProvider treeId={treeId}>{children}</TreeProvider>;
}
