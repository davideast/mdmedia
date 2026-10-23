/** A cast member's id: the upper-cased name used in the story's lines. */
export type CastId = string;

/** A Gemini voice name, or a voice from a named provider. */
export type VoiceRef = string | { provider: 'gemini' | 'elevenlabs'; id: string };

/** A span of the source file, 1-based, end exclusive. */
export interface SourceRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface CastMember {
  id: CastId;
  voice: VoiceRef;
  /** How this character usually sounds; every line's delivery note starts with it. */
  delivery: string;
  /** How this character looks; used by the art milestones. */
  look?: string;
}

export interface Line {
  kind: 'line';
  id: string;
  speaker: CastId;
  /** True for narration paragraphs, spoken by the story's narrator. */
  narration: boolean;
  /** This line's delivery cue; empty when none was written. */
  cue: string;
  /** The words to speak, with inline markdown removed. */
  text: string;
  /** The words as written, for display. */
  display: string;
  source: SourceRange;
}

export interface Pause {
  kind: 'pause';
  id: string;
  durationMs: number;
  source: SourceRange;
}

export type Segment = Line | Pause;

export interface Scene {
  id: string;
  index: number;
  title?: string;
  /** A `##` heading inside the scene: displayed, never spoken. */
  subtitle?: string;
  /** The scene's music cue, from a ```music block before its first line. */
  music?: string;
  segments: Segment[];
}

export interface Chapter {
  id: string;
  index: number;
  title?: string;
  scenes: Scene[];
}

export interface StoryScript {
  schema: 'mdmedia.story.script/1';
  source: { path: string; sha256: string };
  meta: { title: string; author?: string; language: string; names?: string[] };
  gapMs: number;
  /** The cast member who speaks narration: a character, or 'NARRATOR'. */
  narrator: CastId;
  cast: Record<CastId, CastMember>;
  chapters: Chapter[];
}

export type DiagnosticCode =
  | 'missing-front-matter'
  | 'bad-yaml'
  | 'unknown-key'
  | 'missing-field'
  | 'unknown-speaker'
  | 'bad-duration'
  | 'misplaced-music'
  | 'missing-cue'
  | 'placeholder-cue'
  | 'layout-mismatch'
  | 'bad-continue';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  source?: SourceRange;
}

export class StoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source?: SourceRange
  ) {
    super(message);
    this.name = 'StoryError';
  }
}
