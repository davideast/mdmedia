import { apiError, authenticate, forbiddenScope, hasScope, unauthorized } from "@/lib/api-auth";
import { audioObjectPath, loadReadableNarration, readStorageObjectBytes } from "@/lib/narration-server";

export const runtime = "nodejs";

/** The finished recording as a WAV file. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  if (!hasScope(caller, "narrations:read")) return forbiddenScope("narrations:read");

  const { id } = await params;
  const narration = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? await loadReadableNarration(id, caller.uid) : null;
  if (!narration) return apiError(404, "not_found", "No narration with that id is available to you.");
  if (narration.status !== "ready") {
    return apiError(409, "not_ready", `This narration is ${narration.status}. Audio is available once it is ready.`);
  }
  const bytes = await readStorageObjectBytes(audioObjectPath(narration.ownerUid, id));
  if (!bytes) return apiError(404, "not_found", "The recording for this narration is missing.");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="${id}.wav"`,
      "Cache-Control": "no-store",
    },
  });
}
