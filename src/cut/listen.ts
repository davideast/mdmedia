/**
 * The listening check: a model that hears a rendered clip and answers yes/no
 * questions about its delivery. It is a filter for obvious failures, never
 * the judge; the owner's ear decides. `mdmedia cut check --listen` depends
 * only on the `Listener` interface, as `mdmedia cut words` depends only on
 * `Aligner`, so the model can change.
 */

/** A rendered clip: an MP4 with picture and sound, or a WAV. */
export interface ListenClip {
  bytes: Uint8Array;
  /** `video/mp4` or `audio/wav`. */
  mimeType: string;
  /** Its length in seconds. */
  seconds: number;
}

export interface ListenQuestionText {
  id: string;
  ask: string;
}

export interface ListenRequest {
  clip: ListenClip;
  /** Exact facts about the clip (who says what, when), to trust over the model's own estimates. */
  facts: string;
  questions: ListenQuestionText[];
}

/** One answer, as the model gives it. */
export interface ListenAnswer {
  id: string;
  /** Short and plain: "yes", "no", "one continuous delivery", "can't tell". */
  verdict: string;
  /** 0 to 1. */
  confidence: number;
  /** What it heard. */
  heard: string;
  why: string;
}

export interface Listening {
  /** The model's name, e.g. `gemini-3.8-flash`. */
  model: string;
  /** Whether it could hear the sound at all (not just see frames). */
  canHearAudio: boolean;
  answers: ListenAnswer[];
}

/** Hears a clip and answers questions about it. */
export interface Listener {
  /** Recorded with each result; a result from another listener is stale. */
  readonly name: string;
  listen(request: ListenRequest): Promise<Listening>;
}

/** Thrown by a listener that can listen to nothing (no key, no access), so a run stops instead of failing every performance. */
export class ListenerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ListenerUnavailableError';
  }
}

/** What a verdict says, for a yes/no question. */
export type VerdictReading = 'yes' | 'no' | 'unclear';

/**
 * Reads a free-text verdict as yes, no or unclear. "Can't tell" and the like
 * are unclear; "two separate deliveries" and "not shouted" are no; "one
 * continuous delivery" is yes.
 */
export function readVerdict(verdict: string): VerdictReading {
  const v = verdict.trim().toLowerCase();
  if (/can'?t tell|cannot tell|unclear|unsure|not sure|unknown|uncertain/.test(v)) return 'unclear';
  if (/^no\b|^not\b|two separate|separate(ly)? (recorded|deliver)|\bnot (one|continuous|shouted|delivered)\b|^separate/.test(v)) return 'no';
  if (/^yes\b|^one continuous|^continuous|^same\b|^it is\b/.test(v)) return 'yes';
  if (/\bshouted\b/.test(v)) return 'yes';
  return 'unclear';
}
