import { apiError, authenticate, forbiddenScope, hasScope, unauthorized } from "@/lib/api-auth";
import { resolveNarrationBody } from "@/lib/narration-api";
import { activeStreamCount } from "@/lib/narration-server";
import { startNarration } from "@/lib/narration-start";
import { createRateLimiter } from "@/lib/rate-limit";
import { loadUserSettings } from "@/lib/user-settings-server";

export const runtime = "nodejs";

/** Generations one person may have in progress at once. */
const MAX_CONCURRENT = 3;
/** Narrations one API key may start per hour. Browser sessions are not limited here. */
const keyStarts = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

/**
 * Start a narration. Responds 202 as soon as synthesis begins; poll the
 * returned `links.self` until `status` is `ready` or `error`.
 */
export async function POST(request: Request): Promise<Response> {
  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  if (!hasScope(caller, "narrations:create")) return forbiddenScope("narrations:create");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "The request body must be JSON.");
  }

  const resolved = resolveNarrationBody(body, await loadUserSettings(caller.uid), { restricted: caller.kind === "apiKey" });
  if (!resolved.ok) return apiError(resolved.status, resolved.code, resolved.message);

  if (activeStreamCount(caller.uid) >= MAX_CONCURRENT) {
    return apiError(429, "too_many_in_progress", `You have ${MAX_CONCURRENT} narrations generating. Wait for one to finish.`, { "Retry-After": "30" });
  }
  if (caller.kind === "apiKey") {
    const waitMs = keyStarts.take(caller.keyId);
    if (waitMs > 0) {
      return apiError(429, "rate_limited", "This API key has started too many narrations this hour.", { "Retry-After": String(Math.ceil(waitMs / 1000)) });
    }
  }

  // Detach from this request: the response returns now and synthesis carries on.
  const detached = new AbortController();
  const started = await startNarration({ uid: caller.uid, request: resolved.request, signal: detached.signal });
  if (!started.ok) return apiError(started.status, started.code, started.message);
  detached.abort();
  void started.stream.cancel().catch(() => {});

  const origin = new URL(request.url).origin;
  return Response.json({
    id: started.id,
    status: "streaming",
    visibility: resolved.request.visibility,
    links: {
      web: `${origin}/narration/${started.id}`,
      self: `${origin}/api/v1/narrations/${started.id}`,
    },
  }, { status: 202, headers: { Location: `/api/v1/narrations/${started.id}`, "Cache-Control": "no-store" } });
}
