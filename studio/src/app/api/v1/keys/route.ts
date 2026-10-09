import { authenticate, requireUser } from "@/lib/api-auth";
import { listApiKeys } from "@/lib/api-keys";

export const runtime = "nodejs";

/** The signed-in person's connected apps. Never returns a secret. */
export async function GET(request: Request): Promise<Response> {
  const caller = await authenticate(request);
  const denied = requireUser(caller);
  if (denied || !caller) return denied!;
  return Response.json({ keys: await listApiKeys(caller.uid) }, { headers: { "Cache-Control": "no-store" } });
}
