import { apiError, authenticate, forbiddenScope, hasScope, unauthorized } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { toNarrationResource } from "@/lib/narration-api";
import { loadReadableNarration } from "@/lib/narration-server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  if (!hasScope(caller, "narrations:read")) return forbiddenScope("narrations:read");

  const { id } = await params;
  const narration = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? await loadReadableNarration(id, caller.uid) : null;
  if (!narration) return apiError(404, "not_found", "No narration with that id is available to you.");
  return Response.json(toNarrationResource({ ...narration, id }, apiOrigin(request)), {
    headers: { "Cache-Control": "no-store" },
  });
}
