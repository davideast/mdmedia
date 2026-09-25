import { verifyIdToken } from "@/lib/firebase-admin";
import {
  audioObjectPath,
  loadReadableNarration,
  readStorageObjectBytes,
  signedReadUrl,
} from "@/lib/narration-server";

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
    return Response.json({ message: "Please sign in to listen to this narration." }, { status: 401 });
  }
  if (!narration || (narration.status !== "ready" && narration.status !== "streaming")) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }

  const objectPath = audioObjectPath(narration.ownerUid, id);
  const urlObj = new URL(request.url);
  if (urlObj.searchParams.get("raw") === "1") {
    const bytes = await readStorageObjectBytes(objectPath);
    if (!bytes) {
      return Response.json({ message: "That narration isn't available." }, { status: 404 });
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/wav",
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
