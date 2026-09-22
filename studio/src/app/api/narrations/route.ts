import { verifyIdToken } from "@/lib/firebase-admin";
import {
  createNarrationStream,
  newNarrationId,
  parseNarrationRequest,
} from "@/lib/narration-server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to create a narration." }, { status: 401 });
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
      { status: 400 },
    );
  }

  const id = parsed.id ?? newNarrationId();
  const stream = createNarrationStream({
    uid,
    id,
    request: parsed,
    signal: request.signal,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
