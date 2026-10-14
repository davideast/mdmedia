import { apiError, authenticate, unauthorized } from "@/lib/api-auth";
import { revokeApiKey } from "@/lib/api-keys";

export const runtime = "nodejs";

/**
 * Revoke a connected app. A signed-in person may revoke any of their keys; a
 * key may revoke only itself (`/api/v1/keys/current`), which is how a client logs out.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  const { id } = await params;
  const keyId = id === "current" && caller.kind === "apiKey" ? caller.keyId : id;
  if (caller.kind === "apiKey" && keyId !== caller.keyId) {
    return apiError(403, "session_required", "An API key can only revoke itself.");
  }
  if (!(await revokeApiKey(caller.uid, keyId))) return apiError(404, "not_found", "No connected app with that id.");
  return new Response(null, { status: 204 });
}
