import { VOICES, type VoiceChoice, type VoiceProvider, type VoiceRef } from "./types";

export type VoiceFilter = "all" | VoiceProvider;

export interface PreviewVoice extends VoiceChoice {
  previewUrl?: string | null;
  featuredRank?: number;
  source?: "shared" | "personal";
}

/** Keep the user's default first while search and provider filters stay predictable. */
export function visibleVoiceOptions({
  filter,
  query,
  defaultVoice,
  selectedVoice,
  pinnedVoiceRefs,
  elevenLabsVoices,
}: {
  filter: VoiceFilter;
  query: string;
  defaultVoice: VoiceChoice;
  selectedVoice: VoiceChoice;
  pinnedVoiceRefs: VoiceRef[];
  elevenLabsVoices: PreviewVoice[];
}): PreviewVoice[] {
  const needle = query.trim().toLocaleLowerCase();
  const knownElevenLabs = new Map(elevenLabsVoices.map((voice) => [voice.id, voice]));
  const gemini = new Map<string, PreviewVoice>(VOICES.map((name) => [name, { provider: "gemini", id: name, name }]));
  const visible: PreviewVoice[] = [];
  const seen = new Set<string>();

  const add = (voice: PreviewVoice) => {
    if (filter !== "all" && voice.provider !== filter) return;
    const key = `${voice.provider}:${voice.id}`;
    if (seen.has(key)) return;
    const authorized = voice.provider === "elevenlabs" ? knownElevenLabs.get(voice.id) : gemini.get(voice.id);
    if (!authorized) return;
    if (!authorized.name.toLocaleLowerCase().includes(needle)) return;
    seen.add(key);
    visible.push(authorized);
  };

  add(defaultVoice);
  for (const ref of pinnedVoiceRefs) {
    const voice = ref.provider === "elevenlabs" ? knownElevenLabs.get(ref.id) : gemini.get(ref.id);
    if (voice) add(voice);
  }
  for (const voice of [...elevenLabsVoices].sort((a, b) =>
    (a.featuredRank ?? Number.MAX_SAFE_INTEGER) - (b.featuredRank ?? Number.MAX_SAFE_INTEGER))) {
    if (voice.featuredRank !== undefined) add(voice);
  }
  add(selectedVoice);
  for (const voice of elevenLabsVoices) add(voice);
  for (const voice of gemini.values()) add(voice);

  return visible;
}
