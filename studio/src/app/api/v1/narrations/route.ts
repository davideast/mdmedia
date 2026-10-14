import { apiError, authenticate, authorize, forbiddenScope, hasScope, unauthorized } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { resolveNarrationBody, toNarrationResource } from "@/lib/narration-api";
import { activeStreamCount, listOwnNarrations } from "@/lib/narration-server";
import { startNarration } from "@/lib/narration-start";
import { PlaylistOpError } from "@/lib/playlist-ops";
import { placeNarration, playlistErrorResponse, preparePlacement, type PreparedPlacement } from "@/lib/playlists-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { loadUserSettings } from "@/lib/user-settings-server";

export const runtime = "nodejs";

/** Generations one person may have in progress at once. */
const MAX_CONCURRENT = 3;
/** Narrations one API key may start per hour. Browser sessions are not limited here. */
const keyStarts = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

/**
 * Your narrations, newest first. `?q=` matches titles (ignoring case),
 * `?status=` filters by ready, streaming, or error, `?limit=` caps the list.
 */
export async function GET(request: Request): Promise<Response> {
  const caller = await authorize(request, "narrations:read");
  if (caller instanceof Response) return caller;
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  if (status !== null && status !== "ready" && status !== "streaming" && status !== "error") {
    return apiError(400, "invalid_status", "status must be ready, streaming, or error.");
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50) || 50, 1), 500);
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const narrations = (await listOwnNarrations(caller.uid))
    .filter((narration) => (!q || narration.title.toLowerCase().includes(q)) && (!status || narration.status === status))
    .slice(0, limit);
  const origin = apiOrigin(request);
  return Response.json(
    { narrations: narrations.map((narration) => toNarrationResource(narration, origin)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Start a narration. Responds 202 as soon as synthesis begins; poll the
 * returned `links.self` until `status` is `ready` or `error`. With
 * `playlist`, the narration joins that playlist as soon as it starts.
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

  let placement: PreparedPlacement | null = null;
  if (resolved.placement) {
    if (!hasScope(caller, "playlists:manage")) return forbiddenScope("playlists:manage");
    try {
      placement = await preparePlacement(caller.uid, resolved.placement, resolved.request.id);
    } catch (error) {
      return playlistErrorResponse(error);
    }
  }

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

  let playlist: Awaited<ReturnType<typeof placeNarration>> | { error: { code: string; message: string } } | undefined;
  if (placement) {
    try {
      playlist = await placeNarration(caller.uid, placement, started.id);
    } catch (error) {
      // The narration is already generating; report the placement failure alongside it.
      if (!(error instanceof PlaylistOpError)) console.error("[narrations] playlist placement failed:", error);
      playlist = error instanceof PlaylistOpError
        ? { error: { code: error.code, message: error.message } }
        : { error: { code: "playlist_update_failed", message: "The narration started but could not be added to the playlist." } };
    }
  }

  const origin = apiOrigin(request);
  return Response.json({
    id: started.id,
    status: "streaming",
    visibility: resolved.request.visibility,
    ...(playlist ? { playlist } : {}),
    links: {
      web: `${origin}/narration/${started.id}`,
      self: `${origin}/api/v1/narrations/${started.id}`,
    },
  }, { status: 202, headers: { Location: `/api/v1/narrations/${started.id}`, "Cache-Control": "no-store" } });
}
