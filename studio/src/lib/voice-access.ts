import { adminDb } from "./firebase-admin";
import {
  mergeAccessibleVoices,
  parseVoiceRecord,
  resolveAccessibleVoice,
  type AccessibleVoice,
} from "./voice-access-model";
import { isVoiceRef, readDefaultVoiceRef, type VoiceRef } from "./types";

const documentId = (voiceId: string) => `elevenlabs:${voiceId}`;

/** These collections are writable only through Admin SDK operations. */
export async function getAuthorizedVoice(uid: string, voiceId: string): Promise<AccessibleVoice | null> {
  return resolveAccessibleVoice(uid, voiceId, {
    shared: async (id) => (await adminDb().collection("voiceCatalog").doc(documentId(id)).get()).data(),
    personal: async (ownerUid, id) => (await adminDb().collection("users").doc(ownerUid)
      .collection("voiceGrants").doc(documentId(id)).get()).data(),
  });
}

function preferenceRefs(raw: unknown): VoiceRef[] {
  if (!raw || typeof raw !== "object") return [];
  const settings = raw as Record<string, unknown>;
  const refs: VoiceRef[] = [];
  refs.push(readDefaultVoiceRef(settings));
  if (Array.isArray(settings.pinnedVoiceRefs)) {
    for (const ref of settings.pinnedVoiceRefs.slice(0, 20)) {
      if (isVoiceRef(ref)) refs.push(ref);
    }
  }
  return refs;
}

export async function listAuthorizedVoices(uid: string, search: string, cursor: string | null) {
  const db = adminDb();
  const [shared, personal, profile] = await Promise.all([
    db.collection("voiceCatalog").get(),
    db.collection("users").doc(uid).collection("voiceGrants").get(),
    db.collection("users").doc(uid).get(),
  ]);
  const sharedVoices = shared.docs.flatMap((doc) => {
    const parsed = parseVoiceRecord(doc.id, doc.data(), "shared");
    return parsed ? [parsed] : [];
  });
  const personalVoices = personal.docs.flatMap((doc) => {
    const parsed = parseVoiceRecord(doc.id, doc.data(), "personal");
    return parsed ? [parsed] : [];
  });
  const preferenceOrder = new Map(preferenceRefs(profile.data()?.settings)
    .filter((ref) => ref.provider === "elevenlabs")
    .map((ref, index) => [ref.id, index]));
  const needle = search.toLocaleLowerCase();
  const voices = mergeAccessibleVoices(sharedVoices, personalVoices)
    .filter((voice) => voice.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      const rankA = preferenceOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rankB = preferenceOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB || (a.featuredRank ?? Number.MAX_SAFE_INTEGER)
        - (b.featuredRank ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
    });
  const offset = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  const pageSize = 30;
  const page = voices.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    voices: page,
    hasMore: nextOffset < voices.length,
    nextPageToken: nextOffset < voices.length ? String(nextOffset) : undefined,
  };
}
