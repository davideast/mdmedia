/**
 * Ephemeral, verbatim TTS synthesis stream for Studio Contextual Chat messages.
 *
 * Unlike `POST /api/narrations`, this pipeline:
 * - Never writes to Firestore (`narrations/{id}`) or Cloud Storage, keeping the
 *   user's Library and Activity feed completely clean.
 * - Never rewrites or restructures prose (`rewriteForNarration: false`),
 *   guaranteeing 1:1 token alignment with the rendered chat Markdown.
 * - Streams 24 kHz 16-bit mono PCM + `AlignedChunk` word timings + `sourceMap`
 *   as NDJSON frames (`ChatNarrationStreamEvent`), aborting immediately if the
 *   client pauses/switches messages or closes the panel.
 */

import { extractWordTimingsFromPcm } from 'mdmedia/audio';
import { chunkSpeakableParagraphs, parseMarkdownToSpeakableParagraphs } from 'mdmedia/chunker';
import { DocumentAudioPipeline, UniversalEventBus } from 'mdmedia/pipeline';
import { createGeminiClient, createTTSProvider, type ITTSProvider } from 'mdmedia/tts';
import type { DocumentChunk } from 'mdmedia/types';

import { buildTranscriptSourceMap } from '../markdown-word-aligner';
import { classifyNarrationError } from '../narration-errors';
import { alignAudioDelta } from '../narration-server';
import {
  BYTES_PER_MS,
  DEFAULT_SETTINGS,
  DEFAULT_TTS_MODEL,
  readDefaultVoiceRef,
  VOICES,
  type AlignedChunk,
  type AlignedWord,
  type UserSettings,
  type VoiceName,
} from '../types';
import { loadUserSettings } from '../user-settings-server';
import { hasConfiguredFirestoreEnv } from './tools/action-tools';
import { getAuthorizedVoice } from '../voice-access';
import type { ChatNarrationStreamEvent } from './types';

const MAX_CHAT_TTS_CHUNK_CHARS = 400;
const CHUNK_SEPARATOR = '\n\n';

/**
 * Replaces bare or code-fenced `mdmedia://<type>/<id>` tokens (and markdown
 * links whose visible text is itself an `mdmedia://` URI) with equal-length
 * spaces so TTS never reads internal IDs aloud while preserving exact
 * character offsets for `buildTranscriptSourceMap` + `alignMarkdownWords`.
 */
export function stripChatUrisForSpeech(markdown: string): string {
  if (!markdown.includes('mdmedia://')) return markdown;

  return markdown
    // `[mdmedia://...](mdmedia://...)` -> spaces of identical length
    .replace(
      /\[mdmedia:\/\/[^\]]+\]\(mdmedia:\/\/[^)\s]+\)/gi,
      (match) => ' '.repeat(match.length),
    )
    // `` `mdmedia://...` `` -> spaces of identical length
    .replace(
      /`mdmedia:\/\/[a-zA-Z-]+\/[A-Za-z0-9._@/%-]*[A-Za-z0-9_-]`/g,
      (match) => ' '.repeat(match.length),
    )
    // Bare `mdmedia://<kind>/<path>` outside markdown link targets `](...)`
    .replace(
      /(?<!\]\()mdmedia:\/\/[a-zA-Z-]+\/[A-Za-z0-9._@/%-]*[A-Za-z0-9_-]/g,
      (match) => ' '.repeat(match.length),
    );
}

class ChatNarrationEventQueue {
  private readonly items: ChatNarrationStreamEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(event: ChatNarrationStreamEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async next(): Promise<ChatNarrationStreamEvent | null> {
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
  return {
    transcript: chunks.map((chunk) => chunk.text).join(CHUNK_SEPARATOR),
    offsets,
  };
}

interface ResolvedChatVoice {
  provider: 'gemini' | 'elevenlabs';
  voiceId: VoiceName;
  model?: string;
  promptStyle?: string;
  elevenLabsApiKey?: string;
}

async function resolveChatNarrationVoice(
  uid: string,
  settings: UserSettings,
): Promise<ResolvedChatVoice> {
  const ref = readDefaultVoiceRef(settings);
  if (ref.provider === 'elevenlabs') {
    const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY;
    if (apiKey) {
      try {
        const authorized = await getAuthorizedVoice(uid, ref.id);
        if (authorized) {
          return {
            provider: 'elevenlabs',
            voiceId: ref.id as VoiceName,
            elevenLabsApiKey: apiKey,
          };
        }
      } catch {
        // Fall through to Gemini default voice if lookup fails
      }
    }
  }

  const fallbackVoice: VoiceName = VOICES[0];
  const candidateId: VoiceName =
    ref.provider === 'gemini' && (VOICES as readonly string[]).includes(ref.id)
      ? (ref.id as VoiceName)
      : (DEFAULT_SETTINGS.defaultVoice as VoiceName) || fallbackVoice;

  return {
    provider: 'gemini',
    voiceId: candidateId,
    model: settings.defaultGeminiModel || DEFAULT_TTS_MODEL,
    promptStyle: settings.defaultPromptStyle?.trim() || undefined,
  };
}

export interface CreateChatNarrationStreamOptions {
  uid: string;
  markdown: string;
  signal: AbortSignal;
  settingsOverride?: UserSettings;
  ttsProviderFactory?: (resolved: ResolvedChatVoice) => ITTSProvider;
}

export function createChatNarrationStream(
  options: CreateChatNarrationStreamOptions,
): ReadableStream<Uint8Array> {
  const { uid, markdown, signal, settingsOverride, ttsProviderFactory } = options;
  const encoder = new TextEncoder();
  const queue = new ChatNarrationEventQueue();

  let cancelled = signal.aborted;
  let pipeline: DocumentAudioPipeline | null = null;
  let pipelineError: Error | null = null;
  let currentChunkIndex = 0;

  const detachStream = () => {
    if (cancelled) return;
    cancelled = true;
    pipeline?.abort();
    queue.close();
  };

  signal.addEventListener('abort', detachStream, { once: true });

  const run = async () => {
    let resolvedVoice: ResolvedChatVoice = {
      provider: 'gemini',
      voiceId: (DEFAULT_SETTINGS.defaultVoice as VoiceName) || VOICES[0],
      model: DEFAULT_TTS_MODEL,
    };

    try {
      if (cancelled) return;

      const settings =
        settingsOverride ??
        (hasConfiguredFirestoreEnv()
          ? await loadUserSettings(uid).catch(() => DEFAULT_SETTINGS)
          : DEFAULT_SETTINGS);
      if (cancelled) return;

      resolvedVoice = await resolveChatNarrationVoice(uid, settings);
      if (cancelled) return;

      const cleanedMarkdown = stripChatUrisForSpeech(markdown);
      const parseOpts = {
        preserveHeadings: true,
        verbalizeDiagrams: settings.verbalizeDiagrams,
      };
      const speakableParagraphs = parseMarkdownToSpeakableParagraphs(
        cleanedMarkdown,
        parseOpts,
      );
      const documentChunks = chunkSpeakableParagraphs(
        speakableParagraphs,
        MAX_CHAT_TTS_CHUNK_CHARS,
      );

      if (documentChunks.length === 0) {
        queue.push({
          type: 'error',
          message: 'There is no speakable text in this message.',
        });
        return;
      }

      const { transcript, offsets } = buildTranscript(documentChunks);
      const { sourceMap } = buildTranscriptSourceMap(
        cleanedMarkdown,
        parseOpts,
        transcript,
      );

      queue.push({
        type: 'transcript',
        transcript,
        chunkOffsets: offsets,
        sourceMap,
      });

      const ttsProvider = ttsProviderFactory
        ? ttsProviderFactory(resolvedVoice)
        : (() => {
            if (resolvedVoice.provider === 'gemini') {
              const geminiClient = createGeminiClient();
              return createTTSProvider({
                provider: 'gemini',
                geminiClient,
                maxRetries: 2,
                model: resolvedVoice.model,
              });
            }
            return createTTSProvider({
              provider: 'elevenlabs',
              apiKey: resolvedVoice.elevenLabsApiKey,
              maxRetries: 2,
            });
          })();

      const bus = new UniversalEventBus();
      pipeline = new DocumentAudioPipeline(ttsProvider, bus);

      let totalBytes = 0;
      let chunkStartBytes = 0;
      let pendingChunkParts: Uint8Array[] = [];
      let pendingChunkBytes = 0;
      let carry: Uint8Array | null = null;

      bus.on('chunk:start', ({ chunk }) => {
        currentChunkIndex = chunk.index;
      });

      bus.on('pipeline:error', ({ error }) => {
        pipelineError ??= error;
      });

      bus.on('audio:delta', ({ chunkIndex, audioData }) => {
        if (cancelled || audioData.byteLength === 0) return;
        const copy = new Uint8Array(audioData);
        pendingChunkParts.push(copy);
        pendingChunkBytes += copy.byteLength;
        totalBytes += copy.byteLength;

        const alignedResult = alignAudioDelta(copy, carry);
        carry = alignedResult.carry;
        if (alignedResult.aligned.byteLength > 0) {
          queue.push({
            type: 'audio',
            chunkIndex,
            pcm: Buffer.from(alignedResult.aligned).toString('base64'),
          });
        }
      });

      bus.on('chunk:complete', ({ chunkIndex }) => {
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
        queue.push({ type: 'chunk', chunk: aligned });

        chunkStartBytes += pendingChunkBytes;
        pendingChunkParts = [];
        pendingChunkBytes = 0;
      });

      await pipeline.processDocument(
        documentChunks,
        resolvedVoice.voiceId,
        resolvedVoice.provider === 'gemini' ? resolvedVoice.promptStyle : undefined,
      );

      if (cancelled) return;
      if (pipelineError !== null) throw pipelineError;
      if (totalBytes === 0) {
        throw new Error('No audio was generated for this message.');
      }

      const durationMs = Math.round(totalBytes / BYTES_PER_MS);
      queue.push({ type: 'done', durationMs });
    } catch (error) {
      if (cancelled) return;
      const classified = classifyNarrationError(pipelineError ?? error, {
        currentChunkIndex,
        promptStyle: resolvedVoice.promptStyle,
        voiceProvider: resolvedVoice.provider,
      });
      queue.push({
        type: 'error',
        message: classified.message,
      });
    } finally {
      signal.removeEventListener('abort', detachStream);
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
