import { adminDb, verifyIdToken } from "@/lib/firebase-admin";
import { parseNarrationRequest } from "@/lib/narration-request";
import { startNarration } from "@/lib/narration-start";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Re-records a narration whose audio retention deleted, into the same id, from
 * the stored text and settings. Playlist entries, tree links and sharing stay
 * pointed at it. Generation continues on the server whether or not the caller
 * reads the response; progress lands in the narration document.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to narrate again." }, { status: 401 });
  }

  const { id } = await params;
  const data = (await adminDb().collection("narrations").doc(id).get()).data();
  if (!data || data.ownerUid !== uid) {
    return Response.json({ message: "That narration isn't available." }, { status: 404 });
  }
  if (typeof data.audioExpiredAt !== "number") {
    return Response.json(
      { message: "This narration still has its audio.", code: "audio_present" },
      { status: 409 },
    );
  }
  // A private voice id is never stored on the narration, so it cannot be recovered here.
  if (data.voiceProvider === "elevenlabs") {
    return Response.json(
      { message: "This narration used a private voice. Create it again from the composer.", code: "voice_unavailable" },
      { status: 422 },
    );
  }

  const parsed = parseNarrationRequest({
    id,
    markdown: data.sourceMarkdown,
    voice: data.voice,
    voiceProvider: data.voiceProvider ?? "gemini",
    voiceId: data.voiceId ?? data.voice,
    model: data.model,
    promptStyle: data.promptStyle,
    speed: data.speed,
    verbalizeDiagrams: data.verbalizeDiagrams,
    rewriteForNarration: data.adapted === true,
    visibility: data.visibility,
  });
  if (!parsed) {
    return Response.json({ message: "This narration's text or settings can't be narrated again." }, { status: 422 });
  }

  const started = await startNarration({ uid, request: parsed, signal: request.signal });
  if (!started.ok) {
    return Response.json({ message: started.message, code: started.code }, { status: started.status });
  }
  // Generation is already running; the document carries the progress.
  void started.stream.cancel().catch(() => {});
  return Response.json({ id: started.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
