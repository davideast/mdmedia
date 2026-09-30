import { describe, expect, it } from "bun:test";
import { parseVoiceRecord, resolveAccessibleVoice } from "../../studio/src/lib/voice-access-model";

import { parseNarrationRequest } from "../../studio/src/lib/narration-request";
import { isVoiceDisplayName, MAX_VOICE_NAME_LENGTH } from "../../studio/src/lib/voice-name.mjs";

const davidId = "ABCDEFGHIJKLMNOPQRST";
const docId = `elevenlabs:${davidId}`;
const personal = { provider: "elevenlabs", voiceId: davidId, name: "Personal voice", enabled: true };

describe("voice access records", () => {
  it("rejects disabled, malformed, or mismatched records", () => {
    expect(parseVoiceRecord(docId, { ...personal, enabled: false }, "personal")).toBeNull();
    expect(parseVoiceRecord("elevenlabs:wrong", personal, "personal")).toBeNull();
    expect(parseVoiceRecord(docId, { ...personal, voiceId: "bad" }, "personal")).toBeNull();
    expect(parseVoiceRecord(docId, personal, "personal")?.source).toBe("personal");
  });

  it("accepts the entire operator-supported display name range for generation", () => {
    for (const length of [100, 101, MAX_VOICE_NAME_LENGTH]) {
      const name = 'N'.repeat(length);
      expect(isVoiceDisplayName(name)).toBe(true);
      const voice = parseVoiceRecord(docId, { ...personal, name }, "personal");
      expect(voice?.name).toBe(name);
      expect(parseNarrationRequest({
        markdown: 'Read this.', visibility: 'private', voiceProvider: 'elevenlabs', voiceId: davidId, voice: voice?.name,
      })?.voice).toBe(name);
    }
    for (const name of ['', '  ', 'N'.repeat(MAX_VOICE_NAME_LENGTH + 1), 'Voice\nName', 'Voice\u007fName']) {
      expect(isVoiceDisplayName(name)).toBe(false);
      expect(parseVoiceRecord(docId, { ...personal, name }, "personal")).toBeNull();
      expect(parseNarrationRequest({ markdown: 'Read this.', visibility: 'private', voiceProvider: 'elevenlabs', voiceId: davidId, voice: name })).toBeNull();
    }
  });

  it("only grants a private voice through that user's personal lookup", async () => {
    const load = {
      shared: async () => null,
      personal: async (uid: string) => uid === "david" ? personal : null,
    };
    expect(await resolveAccessibleVoice("david", davidId, load)).toMatchObject({ name: "Personal voice" });
    expect(await resolveAccessibleVoice("alice", davidId, load)).toBeNull();
  });

  it("allows a shared voice", async () => {
    const load = { shared: async () => personal, personal: async () => null };
    expect(await resolveAccessibleVoice("alice", davidId, load)).toMatchObject({ source: "shared" });
  });
});
