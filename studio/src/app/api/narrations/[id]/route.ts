import { verifyIdToken } from "@/lib/firebase-admin";
import { purgeNarrationData } from "@/lib/narration-server";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to delete a narration." }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ message: "Missing narration id." }, { status: 400 });
  }

  try {
    const result = await purgeNarrationData(id, uid);
    return Response.json({ ok: true, id, ...result }, { status: 200 });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Failed to purge narration.";
    const status = message.includes("Forbidden") ? 403 : 500;
    return Response.json({ message }, { status });
  }
}
