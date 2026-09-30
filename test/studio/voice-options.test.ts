import { describe, expect, it } from "bun:test";
import { visibleVoiceOptions } from "../../studio/src/lib/voice-options";

const kore = { provider: "gemini" as const, id: "Kore", name: "Kore" };
const puck = { provider: "gemini" as const, id: "Puck", name: "Puck" };
const david = { provider: "elevenlabs" as const, id: "ABCDEFGHIJKLMNOPQRST", name: "Personal voice" };
const burt = { provider: "elevenlabs" as const, id: "1234567890ABCDEFGHIJ", name: "Featured voice", featuredRank: 1 };

describe("voice picker options", () => {
  it("orders the saved default and personal pins before shared featured voices", () => {
    const voices = visibleVoiceOptions({
      filter: "all",
      query: "",
      defaultVoice: kore,
      selectedVoice: puck,
      pinnedVoiceRefs: [{ provider: "elevenlabs", id: david.id }],
      elevenLabsVoices: [burt, { ...david, previewUrl: "https://example.com/david.mp3" }],
    });
    expect(voices.slice(0, 4).map(({ provider, id }) => `${provider}:${id}`)).toEqual([
      "gemini:Kore", `elevenlabs:${david.id}`, `elevenlabs:${burt.id}`, "gemini:Puck",
    ]);
    expect(voices.filter((voice) => voice.id === "Kore")).toHaveLength(1);
    expect(voices[1]?.previewUrl).toBe("https://example.com/david.mp3");
  });

  it("does not offer an unauthorized saved private voice", () => {
    const voices = visibleVoiceOptions({
      filter: "all", query: "", defaultVoice: david, selectedVoice: david,
      pinnedVoiceRefs: [{ provider: "elevenlabs", id: david.id }],
      elevenLabsVoices: [],
    });
    expect(voices.some((voice) => voice.id === david.id)).toBe(false);
  });

  it("applies provider and search filters to featured voices", () => {
    const input = {
      query: "featured",
      defaultVoice: kore,
      selectedVoice: kore,
      pinnedVoiceRefs: [],
      elevenLabsVoices: [burt],
    };
    expect(visibleVoiceOptions({ ...input, filter: "all" }).map((voice) => voice.id))
      .toEqual([burt.id]);
    expect(visibleVoiceOptions({ ...input, filter: "gemini" })).toEqual([]);
    expect(visibleVoiceOptions({ ...input, filter: "elevenlabs" }).map((voice) => voice.id))
      .toEqual([burt.id]);
  });
});
