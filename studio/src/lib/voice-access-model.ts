import { isVoiceDisplayName } from "./voice-name.mjs";
import { isElevenLabsVoiceId, type VoiceChoice } from "./types";

export interface AccessibleVoice extends VoiceChoice {
  source: "shared" | "personal";
  featuredRank?: number;
  previewUrl?: string | null;
}

/** Validate server-managed records before exposing or authorizing them. */
export function parseVoiceRecord(
  documentId: string,
  value: unknown,
  source: AccessibleVoice["source"],
): AccessibleVoice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== "elevenlabs" || !isElevenLabsVoiceId(raw.voiceId)
    || documentId !== `elevenlabs:${raw.voiceId}` || raw.enabled !== true
    || !isVoiceDisplayName(raw.name)) return null;
  const voice: AccessibleVoice = {
    provider: "elevenlabs", id: raw.voiceId, name: raw.name.trim(), source,
  };
  if (source === "shared" && typeof raw.featuredRank === "number"
    && Number.isInteger(raw.featuredRank) && raw.featuredRank >= 0) {
    voice.featuredRank = raw.featuredRank;
  }
  return voice;
}

export interface VoiceRecordLookup {
  shared: (voiceId: string) => Promise<unknown>;
  personal: (uid: string, voiceId: string) => Promise<unknown>;
}

/** Preferences never participate in authorization. Both backing lookups are server-owned. */
export async function resolveAccessibleVoice(
  uid: string,
  voiceId: string,
  lookup: VoiceRecordLookup,
): Promise<AccessibleVoice | null> {
  if (!uid || !isElevenLabsVoiceId(voiceId)) return null;
  const documentId = `elevenlabs:${voiceId}`;
  const shared = parseVoiceRecord(documentId, await lookup.shared(voiceId), "shared");
  if (shared) return shared;
  return parseVoiceRecord(documentId, await lookup.personal(uid, voiceId), "personal");
}

export function mergeAccessibleVoices(
  shared: AccessibleVoice[],
  personal: AccessibleVoice[],
): AccessibleVoice[] {
  const byId = new Map<string, AccessibleVoice>();
  for (const voice of [...personal, ...shared]) byId.set(voice.id, voice);
  return [...byId.values()];
}
