import { compareTranscript } from './diff.js';
import { lineRenderKey } from './key.js';
import { limiter, type Limiter } from './limit.js';
import { deliveryNote, NOTE_LEVELS, type NoteLevel } from './note.js';
import { pcmDurationMs, silence, wavFromPcm } from './pcm.js';
import { SpeechRefused, type LineCheck, type RenderCache, type Speaker, type Transcriber } from './ports.js';
import { heardAsWritten, requireVoice, spokenText } from './pronounce.js';
import type { Line, StoryScript } from './types.js';

export const MAX_RETAKES = 2;

export interface LineResult {
  id: string;
  speaker: string;
  text: string;
  key: string;
  /** Reused from the cache without a new take. */
  cached: boolean;
  /** The note level the provider accepted; above 0 means a refusal fallback. */
  level: NoteLevel;
  /** Takes made for this line in this build (0 when cached). */
  attempts: number;
  heard: string;
  missing: string[];
  extra: string[];
  ok: boolean;
  /** Set when no take was possible at any note level. */
  refused?: boolean;
  durationMs: number;
}

export type LineEvent =
  | { type: 'line-start'; id: string }
  | { type: 'line-retake'; id: string; attempt: number; check: LineCheck }
  | { type: 'line-fallback'; id: string; level: NoteLevel }
  | { type: 'line-done'; result: LineResult };

export interface RenderLinesOptions {
  speaker: Speaker;
  transcriber: Transcriber;
  cache: RenderCache;
  concurrency?: { speak?: number; transcribe?: number };
  signal?: AbortSignal;
  onEvent?: (event: LineEvent) => void;
}

export interface RenderedLine {
  result: LineResult;
  pcm: Uint8Array;
}

/**
 * Voices every line of a script, one line per request, each with its delivery
 * note. Every take is transcribed and compared with the line; a mismatch gets
 * up to MAX_RETAKES new takes, and the closest take is kept. A refusal falls
 * back to a shorter note instead of failing the build. Only takes that pass
 * are cached as accepted.
 */
export async function renderLines(script: StoryScript, options: RenderLinesOptions): Promise<Map<string, RenderedLine>> {
  const lines = script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const speakLimit = limiter(options.concurrency?.speak ?? 4);
  const transcribeLimit = limiter(options.concurrency?.transcribe ?? 6);
  const out = new Map<string, RenderedLine>();
  const emit = options.onEvent ?? (() => {});

  await Promise.all(
    lines.map(async (line) => {
      const rendered = await renderLine(line, script, options, speakLimit, transcribeLimit, emit);
      out.set(line.id, rendered);
      emit({ type: 'line-done', result: rendered.result });
    })
  );
  return out;
}

async function renderLine(
  line: Line,
  script: StoryScript,
  options: RenderLinesOptions,
  speakLimit: Limiter,
  transcribeLimit: Limiter,
  emit: (event: LineEvent) => void
): Promise<RenderedLine> {
  const { speaker, transcriber, cache, signal } = options;
  const key = await lineRenderKey(line, script, speaker.provider);
  const base = { id: line.id, speaker: line.speaker, text: line.text, key };

  const hit = await cache.get(key);
  if (hit?.accepted) {
    return { pcm: hit.pcm, result: { ...base, cached: true, level: 0, attempts: 0, ...hit.check, durationMs: pcmDurationMs(hit.pcm) } };
  }

  const voice = requireVoice(script, line.speaker);
  const say = spokenText(line.text, script.meta.pronounce);
  let level: NoteLevel = 0;
  let best: { pcm: Uint8Array; check: LineCheck } | undefined;
  let attempts = 0;

  emit({ type: 'line-start', id: line.id });
  while (attempts <= MAX_RETAKES) {
    signal?.throwIfAborted();
    let pcm: Uint8Array | undefined;
    for (const candidate of NOTE_LEVELS.filter((l) => l >= level)) {
      try {
        const note = deliveryNote(line, script, candidate);
        pcm = await speakLimit(() => speaker.speak({ text: say, voice, note, signal }));
        level = candidate;
        break;
      } catch (error) {
        if (!(error instanceof SpeechRefused)) throw error;
        if (candidate < 2) emit({ type: 'line-fallback', id: line.id, level: (candidate + 1) as NoteLevel });
      }
    }
    if (!pcm && best) break; // refused on a retake: keep the closest earlier take
    if (!pcm) {
      const fill = silence(1000);
      const check = { heard: '', missing: [], extra: [], ok: false };
      return { pcm: fill, result: { ...base, cached: false, level: 2, attempts, ...check, refused: true, durationMs: pcmDurationMs(fill) } };
    }
    attempts++;
    const heard = await transcribeLimit(() => transcriber.transcribe(wavFromPcm(pcm!), { names: castNames(script), signal }));
    const check = compareTranscript(line.text, heardAsWritten(heard, script.meta.pronounce));
    if (!best || errorCount(check) < errorCount(best.check)) best = { pcm, check };
    if (check.ok) break;
    if (attempts <= MAX_RETAKES) emit({ type: 'line-retake', id: line.id, attempt: attempts + 1, check });
  }

  await cache.put(key, { pcm: best!.pcm, check: best!.check, accepted: best!.check.ok });
  return {
    pcm: best!.pcm,
    result: { ...base, cached: false, level, attempts, ...best!.check, durationMs: pcmDurationMs(best!.pcm) },
  };
}

const errorCount = (check: LineCheck) => check.missing.length + check.extra.length;

/**
 * Names the transcriber should spell the story's way: the cast as a reader
 * would write them (MILO → Milo, without the narrator role), then the
 * story's other names from `names:`.
 */
export function castNames(script: StoryScript): string[] {
  const cast = Object.keys(script.cast)
    .filter((id) => id !== 'NARRATOR')
    .map((id) => id.charAt(0) + id.slice(1).toLowerCase());
  return [...new Set([...cast, ...(script.meta.names ?? [])])];
}
