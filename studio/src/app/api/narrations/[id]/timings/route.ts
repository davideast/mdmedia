import { verifyIdToken } from "@/lib/firebase-admin";
import {
  loadReadableNarration,
  readStorageObjectBytes,
  signedReadUrl,
  timingsObjectPath,
} from "@/lib/narration-server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to open this narration." }, { status: 401 });
  }

  const { id } = await params;
  const narration = await loadReadableNarration(id, uid);
  if (!narration || (narration.status !== "ready" && narration.status !== "streaming")) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }

  const objectPath = narration.timingsPath || timingsObjectPath(narration.ownerUid, id);
  const urlObj = new URL(request.url);
  if (urlObj.searchParams.get("raw") === "1") {
    const bytes = await readStorageObjectBytes(objectPath);
    if (!bytes) {
      return Response.json({ message: "That narration isn't available." }, { status: 404 });
    }
    return new Response(new Uint8Array(bytes), {
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
