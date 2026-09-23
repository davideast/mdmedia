/**
 * Server-side narration synthesis.
 *
 * This module owns the whole generation lifecycle: adapt, chunk, synthesize,
 * align, persist, and stream. The route handler is a thin shell around
 * `createNarrationStream`.
 */

import { chunkSpeakableParagraphs, parseMarkdownToSpeakableParagraphs } from "mdmedia/chunker";
import { extractWordTimingsFromPcm } from "mdmedia/audio";
import {
  DEFAULT_NARRATION_SYSTEM_INSTRUCTION,
  GeminiNarrationAdapter,
  HEADING_GENERATION_NARRATION_PROMPT,
} from "mdmedia/narration";
import { GeminiMarkdownStructureAdapter } from "mdmedia/markdown";
import { DocumentAudioPipeline, UniversalEventBus } from "mdmedia/pipeline";
import { GeminiTTSProvider, createGeminiClient } from "mdmedia/tts";
import type { DocumentChunk } from "mdmedia/types";

import { adminAuth, adminBucket, adminDb } from "./firebase-admin";
import {
  BYTES_PER_MS,
  VOICES,
  type AlignedChunk,
  type AlignedWord,
  type Narration,
  type StreamEvent,
  type Visibility,
  type VoiceName,
} from "./types";
import { wrapPcmAsWav, type NarrationTimingsFile } from "./wav";
import {
  classifyNarrationError,
  type ClassifiedNarrationError,
} from "./narration-errors";

const MAX_CHUNK_CHARS = 400;
const NARRATION_MODEL = "gemini-3.5-flash-lite";
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const CHUNK_SEPARATOR = "\n\n";

const GENERIC_FAILURE =
  "Something went wrong while creating this narration. Please try again.";
const MISSING_KEY_FAILURE =
  "Narration is temporarily unavailable. Please try again shortly.";
const EMPTY_SOURCE_FAILURE =
  "There was nothing to narrate in this document. Add some text and try again.";
const CANCELLED_MESSAGE = "This narration was cancelled before it finished.";

import type { NarrationRequest } from './narration-request';
export type { NarrationRequest };
export { parseNarrationRequest } from './narration-request';

/** A human title for the narration, taken from the document where possible. */
export function deriveTitle(markdown: string, fallbackText: string): string {
  const heading = markdown.match(/^\s{0,3}#{1,3}\s+(.+)$/m);
  const candidate = heading
    ? heading[1]
    : (fallbackText.match(/[^.!?\n]+[.!?]?/)?.[0] ?? "");
  const cleaned = candidate
    .replace(/[*_`~#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "Untitled narration";
  return cleaned.length > 72 ? `${cleaned.slice(0, 71).trimEnd()}…` : cleaned;
}

export function audioObjectPath(uid: string, id: string): string {
  return `narrations/${uid}/${id}.wav`;
}

export function timingsObjectPath(uid: string, id: string): string {
  return `narrations/${uid}/${id}.timings.json`;
}

/** Allocates the document id that the Storage objects will reuse verbatim. */
export function newNarrationId(): string {
  return adminDb().collection("narrations").doc().id;
}

/**
 * A single-consumer async queue. The pipeline's event bus dispatches
 * synchronously, so producers hand events off here and the response stream
 * pulls them at its own pace.
 */
class EventQueue {
  private readonly items: StreamEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(event: StreamEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async next(): Promise<StreamEvent | null> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return item;
      if (this.closed) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function concatPcm(parts: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function buildTranscript(chunks: DocumentChunk[]): { transcript: string; offsets: number[] } {
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    offsets.push(cursor);
    cursor += chunk.text.length + CHUNK_SEPARATOR.length;
  }
  return { transcript: chunks.map((chunk) => chunk.text).join(CHUNK_SEPARATOR), offsets };
}

async function readAuthorProfile(uid: string): Promise<{ name: string; photo: string }> {
  try {
    const user = await adminAuth().getUser(uid);
    return { name: user.displayName ?? "", photo: user.photoURL ?? "" };
  } catch {
    return { name: "", photo: "" };
  }
}

interface ActiveStream {
  uid: string;
  abort: () => void;
}

const activeStreams = new Map<string, ActiveStream>();

/**
 * Cancels and deletes an entire narration and its associated data (Firestore document,
 * playlist references, and Storage assets) atomically in a transaction.
 */
export async function purgeNarrationData(
  id: string,
  uid: string,
): Promise<{ deleted: boolean }> {
  // 1. Abort any in-flight synthesis pipeline
  const active = activeStreams.get(id);
  if (active && active.uid === uid) {
    active.abort();
    activeStreams.delete(id);
  }

  const docRef = adminDb().collection("narrations").doc(id);

  // 2. Atomic deletion in a Firestore transaction
  await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return;
    const data = snap.data();
    if (data?.ownerUid && data.ownerUid !== uid) {
      throw new Error("Forbidden: You do not own this narration.");
    }
    tx.delete(docRef);
  });

  // 3. Remove narration ID from any of the user's playlists in a transaction
  try {
    const playlistsSnap = await adminDb()
      .collection("playlists")
      .where("ownerUid", "==", uid)
      .where("narrationIds", "array-contains", id)
      .get();

    if (!playlistsSnap.empty) {
      await adminDb().runTransaction(async (tx) => {
        for (const pDoc of playlistsSnap.docs) {
          const pSnap = await tx.get(pDoc.ref);
          if (pSnap.exists) {
            const nextIds = ((pSnap.data()?.narrationIds as string[]) ?? []).filter(
              (item) => item !== id,
            );
            tx.update(pDoc.ref, { narrationIds: nextIds, updatedAt: Date.now() });
          }
        }
      });
    }
  } catch (err) {
    console.error(`[narration] playlist cleanup failed for ${id}:`, err);
  }

  // 4. Delete Cloud Storage objects
  try {
    const bucket = adminBucket();
    await Promise.allSettled([
      bucket.file(audioObjectPath(uid, id)).delete({ ignoreNotFound: true }),
      bucket.file(timingsObjectPath(uid, id)).delete({ ignoreNotFound: true }),
    ]);
  } catch (err) {
    console.error(`[narration] storage cleanup failed for ${id}:`, err);
  }

  return { deleted: true };
}

interface StreamParams {
  uid: string;
  id: string;
  request: NarrationRequest;
  signal: AbortSignal;
}

/**
 * Runs the full generation and returns the NDJSON body for the response.
 *
 * Events are emitted in the order the contract documents: one `meta`, one
 * `transcript`, interleaved `audio` / `chunk`, then a single terminal `done`
 * or `error`.
 */
export function createNarrationStream({
  uid,
  id,
  request,
  signal,
}: StreamParams): ReadableStream<Uint8Array> {
  const queue = new EventQueue();
  const encoder = new TextEncoder();
  const docRef = adminDb().collection("narrations").doc(id);

  let pipeline: DocumentAudioPipeline | null = null;
  let cancelled = false;
  let docWritten = false;

  const abortStream = () => {
    cancelled = true;
    pipeline?.abort();
    queue.close();
  };

  activeStreams.set(id, { uid, abort: abortStream });

  // Disconnecting the HTTP stream (e.g. a browser refresh) closes the live
  // NDJSON response queue, while `run()` continues in the background so the
  // reloaded page can pick up the checkpoints and final recording via Firestore.
  const detachStream = () => {
    queue.close();
  };

  signal.addEventListener("abort", detachStream);

  const failDocument = async (error: ClassifiedNarrationError | string) => {
    if (!docWritten) return;
    try {
      const updateData: Record<string, any> = {
        status: "error",
        updatedAt: Date.now(),
      };
      if (typeof error === "string") {
        updateData.errorMessage = error;
      } else {
        updateData.errorMessage = error.message;
        updateData.errorCode = error.code;
        updateData.errorCategory = error.category;
        if (error.chunkIndex !== undefined) updateData.errorChunkIndex = error.chunkIndex;
        if (error.actionableHint) updateData.errorActionableHint = error.actionableHint;
      }
      await docRef.update(updateData);
    } catch {
      // The stream is already terminating; a failed status write must not mask it.
    }
  };

  // Atomic purge helper for cancelled generations
  const purgeDocumentAndStorage = async () => {
    if (docWritten) {
      try {
        await adminDb().runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          if (snap.exists) {
            tx.delete(docRef);
          }
        });
      } catch {
        // Best-effort if already deleted by purgeNarrationData
      }
    }
    await discardObjects();
  };

  // Best-effort cleanup, called only from the failure path. `adminBucket()`
  // itself can throw, and an escaping error here becomes an unhandled
  // rejection that masks whatever actually went wrong.
  const discardObjects = async () => {
    try {
      const bucket = adminBucket();
      await Promise.allSettled([
        bucket.file(audioObjectPath(uid, id)).delete({ ignoreNotFound: true }),
        bucket.file(timingsObjectPath(uid, id)).delete({ ignoreNotFound: true }),
      ]);
    } catch {
      // Nothing useful to do: the narration is already marked failed.
    }
  };

  const run = async () => {
    let pipelineError: Error | null = null;
    let currentProcessingChunkIndex: number | undefined = undefined;

    try {
      const client = createGeminiClient();

      const author = await readAuthorProfile(uid);
      const now = Date.now();
      const initialTitle = deriveTitle(request.markdown, "");

      // Seed the Firestore document immediately with status: "streaming" so that
      // real-time listeners and security rules succeed from the outset, even while
      // long-running adaptation or synthesis is underway.
      const initialNarration: Narration = {
        id,
        ownerUid: uid,
        title: initialTitle,
        sourceMarkdown: request.markdown,
        transcript: "",
        voice: request.voice,
        promptStyle: request.promptStyle,
        adapted: request.rewriteForNarration,
        status: "streaming",
        durationMs: 0,
        audioPath: "",
        timingsPath: "",
        visibility: request.visibility,
        sharedWith: [],
        authorName: author.name,
        authorPhoto: author.photo,
        createdAt: now,
        updatedAt: now,
      };
      await docRef.set(initialNarration);
      docWritten = true;

      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }

      let sourceMarkdown = request.markdown;
      if (request.structureMarkdown) {
        try {
          const structureAdapter = new GeminiMarkdownStructureAdapter(client);
          const structured = await structureAdapter.structureMarkdown(sourceMarkdown);
          if (structured && structured.length > 0) {
            sourceMarkdown = structured;
            await docRef.update({
              sourceMarkdown,
              title: deriveTitle(sourceMarkdown, ""),
              updatedAt: Date.now(),
            });
          }
        } catch (structureError) {
          console.warn("[NarrationServer] Structure markdown fallback to raw:", structureError);
        }
      }

      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }

      /**
       * Delivery customization shapes both the script and the speech synthesis:
       *
       * 1. Script Adaptation: If rewrite is enabled, the delivery note informs
       *    phrasing, sentence pacing, and vocabulary.
       * 2. TTS Voice Synthesis: In `pipeline.processDocument`, the delivery note
       *    is passed to `GeminiTTSProvider`, which supplies it as stage directions
       *    to steer the voice persona, tone, and cadence without speaking them aloud.
       */
      const deliveryNote = request.promptStyle.trim();
      const adaptationInstructions =
        request.rewriteInstructions?.trim() || HEADING_GENERATION_NARRATION_PROMPT;
      const customPrompt = [
        adaptationInstructions,
        deliveryNote.length > 0 ? `Delivery: ${deliveryNote}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");

      const script = request.rewriteForNarration
        ? await new GeminiNarrationAdapter(client, {
            model: NARRATION_MODEL,
            systemInstruction: DEFAULT_NARRATION_SYSTEM_INSTRUCTION,
            customPrompt,
          }).adaptForNarration(sourceMarkdown)
        : sourceMarkdown;

      const documentChunks = chunkSpeakableParagraphs(
        parseMarkdownToSpeakableParagraphs(
          script.trim().length > 0 ? script : sourceMarkdown,
          { preserveHeadings: true },
        ),
        MAX_CHUNK_CHARS,
      );

      if (documentChunks.length === 0) {
        queue.push({ type: "error", message: EMPTY_SOURCE_FAILURE });
        return;
      }
      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }

      const { transcript, offsets } = buildTranscript(documentChunks);
      const title = deriveTitle(sourceMarkdown, transcript);

      await docRef.update({
        title,
        transcript,
        updatedAt: Date.now(),
      });

      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }

      queue.push({
        type: "meta",
        id,
        title,
        voice: request.voice,
        totalChunks: documentChunks.length,
        totalChars: transcript.length,
      });
      queue.push({ type: "transcript", transcript, chunkOffsets: offsets });

      const bus = new UniversalEventBus();
      pipeline = new DocumentAudioPipeline(
        new GeminiTTSProvider(client),
        bus,
      );

      const allPcm: Uint8Array[] = [];
      let totalBytes = 0;
      let chunkStartBytes = 0;
      let pendingChunkParts: Uint8Array[] = [];
      let pendingChunkBytes = 0;
      const alignedChunks: AlignedChunk[] = [];

      /**
       * `DocumentAudioPipeline` reports provider failures by emitting
       * `pipeline:error` — it does **not** reject `processDocument`, which
       * resolves normally afterwards. Without this listener a failed
       * synthesis is indistinguishable from a successful one that produced no
       * audio, and the only symptom is a zero-byte result.
       */
      bus.on("chunk:start", ({ chunk }) => {
        currentProcessingChunkIndex = chunk.index;
      });

      bus.on("pipeline:error", ({ error }) => {
        pipelineError ??= error;
      });

      bus.on("audio:delta", ({ chunkIndex, audioData }) => {
        if (cancelled || audioData.byteLength === 0) return;
        const copy = new Uint8Array(audioData);
        allPcm.push(copy);
        pendingChunkParts.push(copy);
        pendingChunkBytes += copy.byteLength;
        totalBytes += copy.byteLength;
        queue.push({
          type: "audio",
          chunkIndex,
          pcm: Buffer.from(copy).toString("base64"),
        });
      });

      const audioPath = audioObjectPath(uid, id);
      const timingsPath = timingsObjectPath(uid, id);
      const objectMetadata = { metadata: { ownerUid: uid, visibility: request.visibility } };

      const persistSnapshot = async (status: "streaming" | "ready") => {
        if (totalBytes === 0) return;
        const durationMs = Math.round(totalBytes / BYTES_PER_MS);
        const wav = wrapPcmAsWav(concatPcm(allPcm, totalBytes));
        const timingsFile: NarrationTimingsFile = {
          id,
          title,
          transcript,
          durationMs,
          chunks: [...alignedChunks],
          sourceMarkdown,
          adapted: request.rewriteForNarration,
        };
        const audioBuffer = Buffer.from(wav);
        const timingsBuffer = Buffer.from(JSON.stringify(timingsFile));

        const bucket = adminBucket();
        await Promise.all([
          bucket.file(audioPath).save(audioBuffer, {
            contentType: "audio/wav",
            resumable: false,
            metadata: objectMetadata,
          }),
          bucket.file(timingsPath).save(timingsBuffer, {
            contentType: "application/json",
            resumable: false,
            metadata: objectMetadata,
          }),
        ]);

        await docRef.update({
          status,
          durationMs,
          audioPath,
          timingsPath,
          updatedAt: Date.now(),
        });

        return durationMs;
      };

      let checkpointChain = Promise.resolve();

      bus.on("chunk:complete", ({ chunkIndex }) => {
        const source = documentChunks[chunkIndex];
        if (cancelled || source === undefined) return;

        const chunkPcm = concatPcm(pendingChunkParts, pendingChunkBytes);
        const docOffset = offsets[chunkIndex] ?? 0;
        const startMs = Math.round(chunkStartBytes / BYTES_PER_MS);
        const endMs = Math.round((chunkStartBytes + pendingChunkBytes) / BYTES_PER_MS);

        const words: AlignedWord[] = extractWordTimingsFromPcm(
          chunkPcm,
          source.text,
          startMs,
        ).map((timing) => ({
          startMs: timing.startMs,
          endMs: timing.endMs,
          charStart: timing.charStart + docOffset,
          charEnd: timing.charEnd + docOffset,
        }));

        const aligned: AlignedChunk = {
          index: chunkIndex,
          startMs,
          endMs,
          docOffset,
          text: source.text,
          words,
        };
        alignedChunks.push(aligned);
        queue.push({ type: "chunk", chunk: aligned });

        chunkStartBytes += pendingChunkBytes;
        pendingChunkParts = [];
        pendingChunkBytes = 0;

        checkpointChain = checkpointChain
          .then(() => persistSnapshot("streaming"))
          .then(() => undefined)
          .catch(() => undefined);
      });

      await pipeline.processDocument(documentChunks, request.voice, request.promptStyle);
      await checkpointChain;

      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }
      if (pipelineError !== null) throw pipelineError;
      if (totalBytes === 0) {
        const classified = classifyNarrationError(
          pipelineError ?? new Error("No audio was generated for this document."),
          {
            currentChunkIndex: currentProcessingChunkIndex,
            promptStyle: request.promptStyle,
          }
        );
        await failDocument(classified);
        queue.push({
          type: "error",
          message: classified.message,
          code: classified.code,
          category: classified.category,
          chunkIndex: classified.chunkIndex,
          actionableHint: classified.actionableHint,
          retryable: classified.retryable,
        });
        return;
      }

      const durationMs = (await persistSnapshot("ready")) ?? Math.round(totalBytes / BYTES_PER_MS);
      queue.push({ type: "done", id, durationMs });
    } catch (error) {
      if (cancelled) {
        await purgeDocumentAndStorage();
        return;
      }
      if (process.env.NODE_ENV !== "production") {
        console.error("[narration] synthesis failed:", error);
      }
      const classified = classifyNarrationError(pipelineError ?? error, {
        currentChunkIndex: currentProcessingChunkIndex,
        promptStyle: request.promptStyle,
      });
      await failDocument(classified);
      await discardObjects();
      queue.push({
        type: "error",
        message: classified.message,
        code: classified.code,
        category: classified.category,
        chunkIndex: classified.chunkIndex,
        actionableHint: classified.actionableHint,
        retryable: classified.retryable,
      });
    } finally {
      activeStreams.delete(id);
      signal.removeEventListener("abort", detachStream);
      queue.close();
    }
  };

  void run();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const event = await queue.next();
      if (event === null) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    cancel() {
      detachStream();
    },
  });
}

/**
 * Loads a narration the caller is allowed to read: the owner, anything public,
 * or a shared narration the caller was named on. Returns `null` for everything
 * else, so a caller cannot tell "not yours" from "does not exist".
 */
export async function loadReadableNarration(
  id: string,
  uid: string,
): Promise<Narration | null> {
  const snapshot = await adminDb().collection("narrations").doc(id).get();
  if (!snapshot.exists) return null;

  const narration = snapshot.data() as Narration | undefined;
  if (!narration) return null;

  const allowed =
    narration.ownerUid === uid ||
    narration.visibility === "public" ||
    (narration.visibility === "shared" && (narration.sharedWith ?? []).includes(uid));

  return allowed ? narration : null;
}

/**
 * Reads an object's raw bytes directly from Cloud Storage (`adminBucket()`).
 */
export async function readStorageObjectBytes(objectPath: string): Promise<Buffer | null> {
  try {
    const file = adminBucket().file(objectPath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [bytes] = await file.download();
    return bytes;
  } catch {
    return null;
  }
}

/** A short-lived read URL for one of the narration's Storage objects. */
export async function signedReadUrl(objectPath: string): Promise<string | null> {
  try {
    const file = adminBucket().file(objectPath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    const [bytes] = await file.download();
    const mime = objectPath.endsWith(".json") ? "application/json" : "audio/wav";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
