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
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to listen to this narration." }, { status: 401 });
  }

  const { id } = await params;
  const narration = await loadReadableNarration(id, uid);
  if (!narration || (narration.status !== "ready" && narration.status !== "streaming")) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }

  const objectPath = narration.audioPath || audioObjectPath(narration.ownerUid, id);
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
