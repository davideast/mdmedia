import { verifyIdToken } from "@/lib/firebase-admin";
import { DEFAULT_TTS_MODEL, TTS_MODELS, VOICES } from "@/lib/types";
import { geminiVoiceSample } from "@/lib/voice-sample";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!(await verifyIdToken(request.headers.get("authorization")))) {
    return Response.json({ message: "Please sign in to sample voices." }, { status: 401 });
  }

  const url = new URL(request.url);
  const voice = url.searchParams.get("voice") ?? "";
  const model = url.searchParams.get("model") ?? DEFAULT_TTS_MODEL;
  if (!(VOICES as readonly string[]).includes(voice) || !(TTS_MODELS as readonly string[]).includes(model)) {
    return Response.json({ message: "Unknown Gemini voice or model." }, { status: 400 });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ message: "Gemini voice samples are unavailable." }, { status: 503 });
  }

  try {
    const wav = await geminiVoiceSample(voice, model, apiKey);
    return new Response(new Uint8Array(wav), {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[voices] Gemini preview failed:", error);
    return Response.json({ message: "Could not generate a voice sample." }, { status: 502 });
  }
}
