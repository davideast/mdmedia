import { verifyIdToken } from "@/lib/firebase-admin";
import { parseNarrationRequest } from "@/lib/narration-server";
import { startNarration } from "@/lib/narration-start";

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

  const started = await startNarration({ uid, request: parsed, signal: request.signal });
  if (!started.ok) {
    return Response.json({ message: started.message }, { status: started.status, headers: cors });
  }

  return new Response(started.stream, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
