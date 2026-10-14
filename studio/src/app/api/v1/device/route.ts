import { apiError } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { startDeviceAuthorization } from "@/lib/api-keys";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const starts = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });

/**
 * Begin connecting a local client. Unauthenticated by design: it only returns a
 * code. Nothing is granted until a signed-in person approves that code in the studio.
 */
export async function POST(request: Request): Promise<Response> {
  if (starts.take("all") > 0) return apiError(429, "rate_limited", "Too many connection attempts. Try again in a few minutes.");
  let body: { clientName?: unknown } = {};
  try { body = await request.json(); } catch { /* A name is optional. */ }
  const started = await startDeviceAuthorization(body?.clientName);
  const origin = apiOrigin(request);
  return Response.json({
    ...started,
    verificationUri: `${origin}/connect`,
    verificationUriComplete: `${origin}/connect?code=${encodeURIComponent(started.userCode)}`,
  }, { headers: { "Cache-Control": "no-store" } });
}
