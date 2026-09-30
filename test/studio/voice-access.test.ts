import { describe, expect, it } from "bun:test";
import { parseVoiceRecord, resolveAccessibleVoice } from "../../studio/src/lib/voice-access-model";

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
