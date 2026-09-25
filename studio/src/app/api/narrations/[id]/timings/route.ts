import { verifyIdToken } from "@/lib/firebase-admin";
import {
  loadReadableNarration,
  readStorageObjectBytes,
  signedReadUrl,
  timingsObjectPath,
} from "@/lib/narration-server";

import type { NarrationTimingsFile } from "@/lib/wav";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Public narrations play for anyone (plan 005); `uid` is null for signed-out
  // or non-allowlisted callers, who can then only reach public narrations.
  const uid = await verifyIdToken(request.headers.get("authorization"));

  const { id } = await params;
  const narration = await loadReadableNarration(id, uid);
  if (!narration && !uid) {
    return Response.json({ message: "Please sign in to open this narration." }, { status: 401 });
  }
  if (!narration || (narration.status !== "ready" && narration.status !== "streaming")) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }

  const objectPath = timingsObjectPath(narration.ownerUid, id);
  const urlObj = new URL(request.url);
  if (urlObj.searchParams.get("raw") === "1") {
    const bytes = await readStorageObjectBytes(objectPath);
    if (!bytes || bytes.length === 0) {
      return Response.json({ message: "That narration isn't available." }, { status: 404 });
    }
    let timings: NarrationTimingsFile;
    try {
      timings = JSON.parse(new TextDecoder().decode(bytes)) as NarrationTimingsFile;
    } catch {
      return Response.json({ message: "Timings data is still generating or invalid." }, { status: 404 });
    }
    if (narration.title) {
      timings.title = narration.title;
    }
    if (timings.sourceMarkdown === undefined && narration.sourceMarkdown) {
      timings.sourceMarkdown = narration.sourceMarkdown;
    }
    if (timings.adapted === undefined && narration.adapted !== undefined) {
      timings.adapted = narration.adapted;
    }
    return Response.json(timings, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  const url = await signedReadUrl(objectPath);
  if (!url) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }

  return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
}
