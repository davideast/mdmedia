import { ElevenLabsVoiceCatalog } from "mdmedia/tts";
import { getAuthorizedVoice } from "./voice-access";
import {
  claimNarrationId,
  createNarrationStream,
  NarrationOwnershipError,
  newNarrationId,
} from "./narration-server";
import type { NarrationRequest } from "./narration-request";

export type StartResult =
  | { ok: true; id: string; stream: ReadableStream<Uint8Array> }
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): StartResult => ({ ok: false, status, code, message });

/**
 * Checks voice access, claims the id, and starts synthesis. Generation runs to
 * completion on the server whether or not anyone reads the returned stream;
 * progress and the final recording land in Firestore and Storage.
 */
export async function startNarration({ uid, request, signal }: {
  uid: string;
  request: NarrationRequest;
  signal: AbortSignal;
}): Promise<StartResult> {
  if (request.voiceProvider === "elevenlabs") {
    let accessible;
    try {
      accessible = await getAuthorizedVoice(uid, request.voiceId);
    } catch (error) {
      console.error("[narrations] voice access lookup failed:", error);
      return fail(503, "voice_check_failed", "Could not verify voice access.");
    }
    if (!accessible) return fail(403, "voice_not_allowed", "You do not have access to that voice.");
    const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY;
    if (!apiKey) return fail(503, "provider_unavailable", "ElevenLabs narration is unavailable.");
    try {
      const voice = await new ElevenLabsVoiceCatalog(apiKey).get(request.voiceId);
      request.voice = accessible.name || voice.name;
    } catch {
      return fail(400, "voice_unavailable", "That ElevenLabs voice is unavailable. Choose another voice.");
    }
  }

  const id = request.id ?? newNarrationId();
  const conflict = fail(409, "id_in_use", "That narration id is already in use.");
  if (!(await claimNarrationId(id, uid))) return conflict;
  try {
    return { ok: true, id, stream: createNarrationStream({ uid, id, request, signal }) };
  } catch (error) {
    // Another user holds a live stream on this id.
    if (error instanceof NarrationOwnershipError) return conflict;
    throw error;
  }
}
