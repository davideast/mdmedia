import { ElevenLabsVoiceCatalog } from "mdmedia/tts";
import { verifyIdToken } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!(await verifyIdToken(request.headers.get("authorization")))) {
    return Response.json({ message: "Please sign in to browse voices." }, { status: 401 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY;
  if (!apiKey) {
    return Response.json({ message: "ElevenLabs voices are unavailable." }, { status: 503 });
  }

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const nextPageToken = url.searchParams.get("cursor") ?? undefined;
  if (search.length > 100 || (nextPageToken?.length ?? 0) > 1024) {
    return Response.json({ message: "Invalid voice search." }, { status: 400 });
  }

  try {
    const page = await new ElevenLabsVoiceCatalog(apiKey).listPage({
      search,
      pageSize: 30,
      nextPageToken,
    });
    return Response.json(page, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (error) {
    console.error("[voices] ElevenLabs search failed:", error);
    return Response.json({ message: "Could not load ElevenLabs voices." }, { status: 502 });
  }
}
