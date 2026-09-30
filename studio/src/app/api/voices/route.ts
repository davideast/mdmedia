import { ElevenLabsVoiceCatalog } from "mdmedia/tts";
import { verifyIdToken } from "@/lib/firebase-admin";
import { getAuthorizedVoice, listAuthorizedVoices } from "@/lib/voice-access";
import { isElevenLabsVoiceId } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json({ message: "Please sign in to browse voices." }, { status: 401 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY;
  if (!apiKey) {
    return Response.json({ message: "ElevenLabs voices are unavailable." }, { status: 503 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const search = (url.searchParams.get("search") ?? "").trim();
  const nextPageToken = url.searchParams.get("cursor") ?? undefined;
  if ((id !== null && !isElevenLabsVoiceId(id)) || search.length > 100 || (nextPageToken?.length ?? 0) > 1024) {
    return Response.json({ message: "Invalid voice search." }, { status: 400 });
  }

  try {
    if (id) {
      const accessible = await getAuthorizedVoice(uid, id);
      if (!accessible) return Response.json({ message: "Voice not found." }, { status: 404 });
      const voice = await new ElevenLabsVoiceCatalog(apiKey).get(id);
      return Response.json({ ...accessible, previewUrl: voice.previewUrl },
        { headers: { "Cache-Control": "private, max-age=300" } });
    }
    const page = await listAuthorizedVoices(uid, search, nextPageToken ?? null);
    if (!page) return Response.json({ message: "Invalid voice cursor." }, { status: 400 });
    return Response.json(page, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (error) {
    console.error("[voices] ElevenLabs search failed:", error);
    return Response.json({ message: "Could not load ElevenLabs voices." }, { status: 502 });
  }
}
