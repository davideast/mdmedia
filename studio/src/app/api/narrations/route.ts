import { verifyIdToken } from "@/lib/firebase-admin";
import {
  claimNarrationId,
  createNarrationStream,
  NarrationOwnershipError,
  newNarrationId,
  parseNarrationRequest,
} from "@/lib/narration-server";

export const runtime = "nodejs";
export const maxDuration = 300;

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const allowed = (process.env.ALLOWED_WEB_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) {
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request);
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json(
      { message: "Please sign in to create a narration." },
      { status: 401, headers: cors },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const parsed = parseNarrationRequest(body);
  if (!parsed) {
    return Response.json(
      { message: "Add some text and choose a voice before creating a narration." },
      { status: 400, headers: cors },
    );
  }

  const conflict = () =>
    Response.json(
      { message: "That narration id is already in use." },
      { status: 409, headers: cors },
    );

  const id = parsed.id ?? newNarrationId();
  if (!(await claimNarrationId(id, uid))) {
    return conflict();
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = createNarrationStream({
      uid,
      id,
      request: parsed,
      signal: request.signal,
    });
  } catch (error) {
    // Another user holds a live stream on this id.
    if (error instanceof NarrationOwnershipError) return conflict();
    throw error;
  }

  return new Response(stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
