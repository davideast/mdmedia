import { apiError, authenticate, requireUser } from "@/lib/api-auth";
import { decideDeviceAuthorization, describeDeviceAuthorization } from "@/lib/api-keys";

export const runtime = "nodejs";

/** What is asking to connect, shown before the person approves. */
export async function GET(request: Request): Promise<Response> {
  const caller = await authenticate(request);
  const denied = requireUser(caller);
  if (denied) return denied;
  const code = new URL(request.url).searchParams.get("code") ?? "";
  const pending = await describeDeviceAuthorization(code);
  if (!pending) return apiError(404, "not_found", "That code is not waiting for approval. It may have expired.");
  return Response.json(pending, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticate(request);
  const denied = requireUser(caller);
  if (denied || !caller || caller.kind !== "user") return denied!;
  let body: { userCode?: unknown; approve?: unknown } = {};
  try { body = await request.json(); } catch { /* Handled below. */ }
  if (typeof body.userCode !== "string" || typeof body.approve !== "boolean") {
    return apiError(400, "invalid_request", "Send { \"userCode\": \"ABCD-EFGH\", \"approve\": true }.");
  }
  if (!(await decideDeviceAuthorization(caller.uid, caller.email, body.userCode, body.approve))) {
    return apiError(404, "not_found", "That code is not waiting for approval. It may have expired.");
  }
  return Response.json({ ok: true });
}
