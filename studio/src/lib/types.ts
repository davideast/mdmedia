/**
 * Shared domain types.
 *
 * This file is the contract between the server (route handlers, admin SDK) and
 * the client (reader, player, studio). Both sides import from here; neither
 * side redefines these shapes locally.
 */

/** The 30 Gemini TTS voices mdmedia accepts. */
export const VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

export type VoiceName = (typeof VOICES)[number];

export const DEFAULT_VOICE: VoiceName = "Kore";

/** Who can read a narration. */
export type Visibility = "private" | "shared" | "public";

/** Upper bound on `sharedWith`, enforced in Rules and on the server. */
export const MAX_SHARED_WITH = 50;

/**
 * A single word, aligned against the audio timeline.
 *
 * `charStart` / `charEnd` index into the **transcript** (the text that was
 * actually spoken), not the user's original markdown. The server resolves the
 * offset before streaming so the client never needs mdmedia's Node-only
 * aligner.
 */
export interface AlignedWord {
  /** Absolute ms from the start of the track. */
  startMs: number;
  endMs: number;
  /** Absolute character offsets into the transcript. */
  charStart: number;
  charEnd: number;
}

/** One synthesized chunk and where it sits in the track and the transcript. */
export interface AlignedChunk {
  index: number;
  startMs: number;
  endMs: number;
  /** Absolute character offset of this chunk's text within the transcript. */
  docOffset: number;
  text: string;
  words: AlignedWord[];
}

/** The Firestore document at `narrations/{id}`. */
export interface Narration {
  id: string;
  ownerUid: string;
  title: string;
  /** What the user pasted in. */
  sourceMarkdown: string;
  /** What was actually spoken. The reader renders this. */
  transcript: string;
  voice: VoiceName;
  promptStyle: string;
  /** Whether the source was rewritten for the ear before synthesis. */
  adapted: boolean;
  status: NarrationStatus;
  durationMs: number;
  /** Storage object name. Shares the document id. */
  audioPath: string;
  /** Storage object name for the word timings. Shares the document id. */
  timingsPath: string;
  visibility: Visibility;
  sharedWith: string[];
  /** Denormalized so a shared narration can be attributed without exposing
   *  the owner's profile, which is owner-only by design. */
  authorName: string;
  authorPhoto: string;
  createdAt: number;
  updatedAt: number;
  /** Present only when `status === "error"`. */
  errorMessage?: string;
}

export type NarrationStatus = "streaming" | "ready" | "error";

/** Upper bound on `narrationIds` per playlist, enforced in Rules. */
export const MAX_PLAYLIST_ITEMS = 100;

/** The Firestore document at `playlists/{id}`. Owner-only. */
export interface Playlist {
  id: string;
  ownerUid: string;
  title: string;
  description: string;
  /** Ordered narration document IDs belonging to this playlist. */
  narrationIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** The Firestore document at `users/{uid}`. Owner-only. */
export interface UserProfile {
  uid: string;
  displayName: string;
  photoURL: string;
  email: string;
  bio: string;
  createdAt: number;
  updatedAt: number;
  settings: UserSettings;
}

/** Predefined inline word highlight presets with WCAG AAA accessible background and text contrast. */
export const HIGHLIGHT_COLORS = [
  {
    id: "amber",
    label: "Amber Gold",
    bg: "#fde68a",
    text: "#1c1917",
  },
  {
    id: "sky",
    label: "Sky Blue",
    bg: "#bae6fd",
    text: "#0c1929",
  },
  {
    id: "emerald",
    label: "Mint Emerald",
    bg: "#a7f3d0",
    text: "#062419",
  },
  {
    id: "violet",
    label: "Soft Violet",
    bg: "#ddd6fe",
    text: "#1e1035",
  },
  {
    id: "rose",
    label: "Coral Rose",
    bg: "#fecdd3",
    text: "#2c0b14",
  },
  {
    id: "lime",
    label: "Highlighter Lime",
    bg: "#d9f99d",
    text: "#1a2e05",
  },
] as const;

export type HighlightColorId = (typeof HIGHLIGHT_COLORS)[number]["id"];

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColorId = "amber";

/**
 * Default prompt extension for generating structured Markdown headings during audio adaptation.
 * Used as the placeholder text in the composer's custom instructions textarea.
 */
export const DEFAULT_HEADING_INSTRUCTIONS = `Document Headings & Section Structure:
- Organize the narrated script using clear, concise Markdown headings (# for the main document title, and ## or ### for major thematic sections and transitions).
- If the source document lacks headings or only has raw prose/notes, synthesize descriptive # and ## section headings at natural topic boundaries so the reader view is well-structured and scannable.
- Place each heading on its own line separated by blank lines (\\n\\n), without trailing periods on the heading line.`;

export interface UserSettings {
  defaultVoice: VoiceName;
  defaultPromptStyle: string;
  /** Rewrite markdown for the ear before synthesis. */
  rewriteForNarration: boolean;
  /** Start playing as soon as the first chunk lands. */
  autoPlay: boolean;
  /** Default visibility for newly created narrations. */
  defaultVisibility: Visibility;
  /** Predefined accessible inline highlight color preset. */
  highlightColor: HighlightColorId;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultVoice: DEFAULT_VOICE,
  defaultPromptStyle: "Warm, unhurried narration.",
  rewriteForNarration: true,
  autoPlay: true,
  defaultVisibility: "private",
  highlightColor: DEFAULT_HIGHLIGHT_COLOR,
};

/* ==========================================================================
   The NDJSON stream contract for POST /api/narrations
   ========================================================================== */

/**
 * Events the generation route streams back, one JSON object per line.
 *
 * Ordering guarantee: exactly one `meta` first, then any number of
 * `transcript` / `audio` / `chunk` events, then exactly one terminal
 * `done` or `error`.
 */
export type StreamEvent =
  | StreamMetaEvent
  | StreamTranscriptEvent
  | StreamAudioEvent
  | StreamChunkEvent
  | StreamDoneEvent
  | StreamErrorEvent;

export interface StreamMetaEvent {
  type: "meta";
  /** The Firestore document id, generated before synthesis starts. The
   *  Storage object shares it. */
  id: string;
  title: string;
  voice: VoiceName;
  totalChunks: number;
  totalChars: number;
}

/** The full spoken script, sent once, before any audio. The reader renders
 *  this immediately so text leads the audio rather than trailing it. */
export interface StreamTranscriptEvent {
  type: "transcript";
  transcript: string;
  /** Character offset of each chunk within the transcript. */
  chunkOffsets: number[];
}

/** A slice of raw 24kHz/16-bit/mono PCM, base64 encoded. No WAV header. */
export interface StreamAudioEvent {
  type: "audio";
  chunkIndex: number;
  pcm: string;
}

/** A chunk finished synthesizing; its alignment is now exact. */
export interface StreamChunkEvent {
  type: "chunk";
  chunk: AlignedChunk;
}

export interface StreamDoneEvent {
  type: "done";
  id: string;
  durationMs: number;
}

export interface StreamErrorEvent {
  type: "error";
  message: string;
}

/* ==========================================================================
   Audio format constants — 24 kHz, 16-bit, mono.
   ========================================================================== */

export const SAMPLE_RATE = 24_000;
export const BYTES_PER_MS = 48;
export const WAV_HEADER_BYTES = 44;
