import { describe, expect, it } from "bun:test";
import type { ITTSProvider } from "mdmedia/tts";
import {
  createChatNarrationStream,
  stripChatUrisForSpeech,
} from "../../studio/src/lib/chat/chat-narration-server";
import type { ChatNarrationStreamEvent } from "../../studio/src/lib/chat/types";
import { findActiveChatNarrationWord } from "../../studio/src/components/chat/use-chat-message-narration";
import { alignMarkdownWords } from "../../studio/src/lib/markdown-word-aligner";
import { DEFAULT_SETTINGS, SAMPLE_RATE, type AlignedChunk, type AlignedWord } from "../../studio/src/lib/types";

function synthesizeVoicedBurstPcm(wordCount: number): Uint8Array {
  // Synthesize distinct voiced bursts separated by short silences at 24 kHz 16-bit mono
  // so `extractWordTimingsFromPcm` assigns deterministic word intervals.
  const samplesPerWord = Math.floor(SAMPLE_RATE * 0.14);
  const silenceSamples = Math.floor(SAMPLE_RATE * 0.05);
  const totalSamples =
    wordCount * samplesPerWord + Math.max(0, wordCount - 1) * silenceSamples;
  const buf = new Uint8Array(totalSamples * 2);
  const view = new DataView(buf.buffer);

  let cursor = 0;
  for (let w = 0; w < wordCount; w += 1) {
    for (let i = 0; i < samplesPerWord; i += 1) {
      const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 14000);
      view.setInt16(cursor * 2, sample, true);
      cursor += 1;
    }
    if (w + 1 < wordCount) {
      cursor += silenceSamples;
    }
  }
  return buf;
}

async function collectNdjsonEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<ChatNarrationStreamEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: ChatNarrationStreamEvent[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        events.push(JSON.parse(line) as ChatNarrationStreamEvent);
      }
      idx = buffer.indexOf("\n");
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) {
    events.push(JSON.parse(rest) as ChatNarrationStreamEvent);
  }
  return events;
}

describe("Chat Ephemeral Verbatim Narration Stream & Word Alignment", () => {
  it("strips bare and code-fenced mdmedia:// URIs with exact length preservation while keeping Markdown link labels intact", () => {
    const raw =
      "Review `mdmedia://narration/nar_99`, open [Opening Cut](mdmedia://video/vid_42), and skip mdmedia://analysis/ana_7.";
    const stripped = stripChatUrisForSpeech(raw);

    expect(stripped.length).toBe(raw.length);
    expect(stripped).not.toContain("nar_99");
    expect(stripped).not.toContain("ana_7");
    expect(stripped).toContain("[Opening Cut](mdmedia://video/vid_42)");
  });

  it("streams transcript -> audio -> chunk -> done NDJSON frames and aligns spoken words 1:1 back to raw chat Markdown", async () => {
    const markdown = [
      "### Key Takeaways",
      "",
      "First takeaway covers the opening framing in mdmedia://video/vid_101 clearly.",
      "",
      "Second takeaway highlights pacing and clean audio transitions across scenes.",
    ].join("\n");

    const spokenCalls: string[] = [];
    const fakeProvider: ITTSProvider = {
      async *streamAudio(text: string) {
        spokenCalls.push(text);
        const approxWords = Math.max(1, text.trim().split(/\s+/).length);
        const pcm = synthesizeVoicedBurstPcm(approxWords);
        // Yield in two uneven slices (including an odd byte boundary) to exercise 16-bit frame alignment
        const splitAt = Math.min(pcm.byteLength - 1, 101);
        yield pcm.subarray(0, splitAt);
        yield pcm.subarray(splitAt);
      },
    };

    const stream = createChatNarrationStream({
      uid: "user_alice",
      markdown,
      signal: new AbortController().signal,
      settingsOverride: DEFAULT_SETTINGS,
      ttsProviderFactory: () => fakeProvider,
    });

    const events = await collectNdjsonEvents(stream);
    expect(events[0]?.type).toBe("transcript");
    expect(events[events.length - 1]?.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);

    // Ensure raw mdmedia:// URI was never sent to TTS
    for (const spoken of spokenCalls) {
      expect(spoken).not.toContain("mdmedia://");
      expect(spoken).not.toContain("vid_101");
    }

    const transcriptEvent = events.find((e) => e.type === "transcript")!;
    expect(transcriptEvent.type).toBe("transcript");

    const chunkEvents = events
      .filter((e): e is Extract<ChatNarrationStreamEvent, { type: "chunk" }> => e.type === "chunk")
      .map((e) => e.chunk as AlignedChunk);
    expect(chunkEvents.length).toBeGreaterThanOrEqual(1);

    const audioEvents = events.filter(
      (e): e is Extract<ChatNarrationStreamEvent, { type: "audio" }> => e.type === "audio",
    );
    expect(audioEvents.length).toBeGreaterThanOrEqual(1);
    for (const audio of audioEvents) {
      const byteLen = Buffer.from(audio.pcm, "base64").byteLength;
      expect(byteLen % 2).toBe(0);
    }

    const allWords: AlignedWord[] = chunkEvents.flatMap((c) => c.words);
    expect(allWords.length).toBeGreaterThan(10);

    // Verify 1:1 alignment back to raw chat Markdown offsets
    const alignment = alignMarkdownWords(
      markdown,
      allWords,
      transcriptEvent.type === "transcript" ? transcriptEvent.sourceMap : undefined,
      chunkEvents,
    );
    expect(alignment.fallbackToPlain).toBe(false);
    expect(alignment.matchRatio).toBeGreaterThan(0.9);

    const firstIdx = markdown.indexOf("First");
    const secondIdx = markdown.indexOf("Second");
    expect(alignment.alignedByMdOffset.has(firstIdx)).toBe(true);
    expect(alignment.alignedByMdOffset.has(secondIdx)).toBe(true);
  });

  it("aborts synthesis immediately when AbortController cancels mid-stream", async () => {
    const controller = new AbortController();
    const paragraphA = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet. ".repeat(7);
    const paragraphB = "Kilo lima mike november oscar papa quebec romeo sierra tango. ".repeat(7);
    const markdown = `${paragraphA}\n\n${paragraphB}`;

    let chunksStarted = 0;
    const fakeProvider: ITTSProvider = {
      async *streamAudio() {
        chunksStarted += 1;
        yield synthesizeVoicedBurstPcm(4);
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        yield synthesizeVoicedBurstPcm(4);
      },
    };

    const stream = createChatNarrationStream({
      uid: "user_alice",
      markdown,
      signal: controller.signal,
      settingsOverride: DEFAULT_SETTINGS,
      ttsProviderFactory: () => fakeProvider,
    });

    const events = await collectNdjsonEvents(stream);
    expect(chunksStarted).toBe(1);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("finds active word via binary search and holds highlight across <= 250ms inter-word gaps", () => {
    const words: AlignedWord[] = [
      { startMs: 0, endMs: 180, charStart: 0, charEnd: 5 },
      { startMs: 320, endMs: 520, charStart: 6, charEnd: 11 },
      { startMs: 950, endMs: 1150, charStart: 12, charEnd: 18 },
    ];

    expect(findActiveChatNarrationWord(words, 90)).toEqual({ charStart: 0, charEnd: 5 });
    // 140ms gap between word 0 (180ms) and word 1 (320ms) -> holds word 0 smoothly
    expect(findActiveChatNarrationWord(words, 240)).toEqual({ charStart: 0, charEnd: 5 });
    // 430ms pause between word 1 (520ms) and word 2 (950ms) -> clears highlight during long pause
    expect(findActiveChatNarrationWord(words, 700)).toBeNull();
    expect(findActiveChatNarrationWord(words, 1020)).toEqual({ charStart: 12, charEnd: 18 });
  });
});
