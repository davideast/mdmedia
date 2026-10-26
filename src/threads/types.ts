/**
 * Review comments on a production's cuts: a thread anchored to a time on one
 * version, its replies, the options an agent suggests, and the production's
 * decision log. Studio stores them as Firestore documents:
 *
 * - `productions/{production}/threads/{threadId}`: a {@link Thread}
 * - `productions/{production}/threads/{threadId}/messages/{messageId}`: a {@link Message}
 * - `productions/{production}/threads/{threadId}/suggestions/{suggestionId}`: a {@link Suggestion}
 * - `productions/{production}/decisions/{decisionId}`: a {@link Decision}
 * - `commentAgents/{id}`: an {@link AgentHeartbeat}
 *
 * Times on a video are seconds; dates are milliseconds since the epoch.
 * A {@link ContextBundle} is not stored: it is everything an agent needs to
 * act on one thread, assembled in one call.
 */

/** What an anchor can point at. Ids are cut ids, except a gap's (below). */
export type ItemKind = 'segment' | 'line' | 'gap' | 'overlay' | 'music' | 'sfx';

/**
 * One item on the cut's timeline. A gap is the pause between two lines in
 * speaking order, timed from the first line's last word to the next line's
 * first word; its id is `<from>-<to>` (cut ids never contain `-`), as the cut
 * viewer keys it.
 */
export interface ItemRef {
  kind: ItemKind;
  id: string;
}

/** An item with its span on the timeline when the anchor was made, so the anchor still reads after the cut changes. */
export interface AnchorItem extends ItemRef {
  start: number;
  end: number;
}

/** Where on a cut's timeline a comment is pinned, in seconds on the output timeline. */
export interface Anchor {
  /** The playhead when the comment was made. */
  time: number;
  /** The stretch the comment is about, when a point says less than it. Contains `time`. */
  range?: { start: number; end: number; why: string };
  /** The items under the playhead, plus the lines and gap around it (`anchorItems`). */
  items: AnchorItem[];
}

/** A word on the output timeline, with the line it belongs to. */
export interface SnapshotWord {
  line: string;
  text: string;
  start: number;
  end: number;
}

/** What the commenter saw and heard at the playhead. */
export interface Snapshot {
  /** Timeline seconds of the frame. */
  at: number;
  /** `4:3` is the middle of the picture as the TV shows it; `16:9` is the whole frame. */
  view: '4:3' | '16:9';
  /** The still, as an image asset, when one was taken. */
  frameAssetId: string | null;
  /** Overlays on screen in the frame. */
  overlays: string[];
  /** Words heard within `window` seconds either side of `at`. */
  window: number;
  words: SnapshotWord[];
}

/**
 * - `open`: waiting for an agent (a new comment, a reply, or an accepted option to apply);
 * - `in-progress`: an agent has claimed it;
 * - `addressed`: the agent has answered (options to choose from, or a new version), waiting for the owner;
 * - `resolved`: closed.
 *
 * What the owner is asked to do is read from the suggestions' states, never stored twice.
 */
export const THREAD_STATUSES = ['open', 'in-progress', 'addressed', 'resolved'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** An agent working on a thread, until `expiresAt` unless it claims again. */
export interface Claim {
  agent: string;
  at: number;
  expiresAt: number;
}

/** A comment anchored to one version of a production. */
export interface Thread {
  id: string;
  /** The production's id. */
  productionId: string;
  /** The version commented on: the cut's id, and when that cut was last changed. */
  version: { cutId: string; cutUpdatedAt: number | null };
  anchor: Anchor;
  snapshot: Snapshot | null;
  text: string;
  /** `owner`, or `agent:<name>`. */
  author: string;
  status: ThreadStatus;
  claim: Claim | null;
  createdAt: number;
  updatedAt: number;
}

/** A video a timed message talks about: a version (a cut), or one of a suggestion's previews. */
export type VideoRef =
  | { kind: 'cut'; cutId: string }
  | { kind: 'preview'; suggestionId: string; assetId: string };

/** A time on a video. On a cut it also records what was under the playhead, with those items' times then. */
export interface TimedRef {
  video: VideoRef;
  time: number;
  anchor?: AnchorItem[];
}

/** A reply on a thread. */
export interface Message {
  id: string;
  threadId: string;
  author: string;
  text: string;
  /** The message it answers. */
  replyTo?: string;
  /** The options this message offers, in order. */
  suggestions?: string[];
  /** The time on a video it is about. */
  at?: TimedRef;
  /** A version this message presents, such as the take an accepted option was applied as. */
  version?: { cutId: string };
  createdAt: number;
}

export const SUGGESTION_STATES = ['proposed', 'accepted', 'rejected', 'applied'] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

/** A video that shows an option, uploaded as production media. */
export interface Preview {
  assetId: string;
  /** What tells it from the option's other previews, e.g. "without the level ride". */
  label?: string;
  durationMs?: number;
}

/** One check run on an option: a listening check's verdicts, or measured values. */
export interface SuggestionCheck {
  /** The preview it checked, by asset id, if any. */
  preview?: string | null;
  passed?: boolean;
  verdicts?: Array<{ id: string; verdict: string; confidence?: number }>;
  pauses?: Array<{ between: string; seconds: number }>;
  levels?: Array<{ phrase: string; meanDb: number }>;
  measured?: string | null;
  notes?: string;
}

/** One option an agent offers for a thread. */
export interface Suggestion {
  id: string;
  threadId: string;
  author: string;
  /** Each time an agent answers is a round; options are lettered within it. */
  round: number;
  letter: string;
  title: string;
  /** The idea, in a sentence or two. */
  approach: string;
  /** What would be done, in order: generations, edits, checks. */
  steps: string[];
  cost: {
    /** Paid video, voice, music or sound generations. */
    generations: number;
    /** Rough wall-clock minutes, generations and edit together. */
    minutes: number;
  };
  risks: string[];
  checks: SuggestionCheck[];
  previews: Preview[];
  /** Decision ids this option keeps, and those it overturns. */
  keeps: string[];
  overturns: string[];
  /** The takes it creates (or created). */
  creates: string[];
  /** The option it revises, if any. */
  revises?: string;
  state: SuggestionState;
  /** The cut id of the version it was applied as. */
  appliedAs?: string;
  stateChangedAt?: number;
  stateChangedBy?: string;
  createdAt: number;
}

export const DECISION_SOURCES = ['owner', 'owner direction', 'brief', 'agent report'] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

/** Why the production is the way it is, or a standing limit every change works within. */
export interface Decision {
  id: string;
  kind: 'decision' | 'constraint';
  /** The version it came from or led to, as written, e.g. `Take 4 -> Take 5`. */
  take?: string;
  source?: DecisionSource;
  /** The owner's words. */
  quote?: string;
  /** The decision, or the constraint. */
  text: string;
  /** When and why it was revised, if it was. */
  revised?: string;
  /** Threads it was decided in. */
  threadIds: string[];
  /** Versions (cut ids) it came from or led to. */
  cutIds: string[];
  order: number;
  createdAt: number;
}

/** An agent saying it is watching for comments. `productionId` null means all of the owner's productions. */
export interface AgentHeartbeat {
  agent: string;
  productionId: string | null;
  seenAt: number;
}

/** How long a heartbeat counts as an agent being there. */
export const HEARTBEAT_FRESH_MS = 3 * 60_000;
/** How long a claim lasts unless the agent claims again. */
export const CLAIM_MS = 20 * 60_000;

// ---------------------------------------------------------------------------
// The context bundle

/** Something the bundle needed and couldn't find in stored data. */
export interface Missing {
  /** What was needed. */
  need: string;
  /** Where it lives now, if anywhere ("only in hal5/SCRIPT.md prose", "not recorded anywhere"). */
  where: string;
  /** The items or takes it concerns. */
  about?: string[];
}

export interface BundleWord {
  text: string;
  start: number;
  end: number;
}

/** A line with its words on the timeline. */
export interface BundleLine {
  id: string;
  /** True for a line the thread is anchored to; false for a neighbour. */
  anchored: boolean;
  speaker: string;
  text: string;
  /** The line's span on the timeline (its audio). */
  start: number;
  end: number;
  /** First word's start to last word's end, when words are known. */
  spoken: { start: number; end: number } | null;
  /** The segment whose picture and sound it plays over, for a line voiced by its segment. */
  segment: string | null;
  /** Its own audio, as an asset id, for a line with its own file. */
  assetId: string | null;
  words: BundleWord[];
  /** The words file entry: what was aligned and how well. */
  alignment: { source: string; window: [number, number]; loss: number | null } | null;
}

export interface BundleGap {
  id: string;
  from: string;
  to: string;
  start: number;
  end: number;
  length: number;
}

/** A shot on the timeline, with where its picture and sound come from. */
export interface BundleSegment {
  id: string;
  label: string;
  start: number;
  end: number;
  /** The take it plays, as an asset id (or a colour). */
  source: string | null;
  in: number;
  out: number;
  hold: number;
  audio: { source: string | null; in: number; out: number } | null;
  /** Its thumbnail, an image asset. */
  thumbnailAssetId: string | null;
}

/** The cut between two segments, with the words either side of it. */
export interface BundleCut {
  at: number;
  from: string;
  to: string;
  lastWordBefore: (SnapshotWord & { before: number }) | null;
  firstWordAfter: (SnapshotWord & { after: number }) | null;
}

export interface BundleClip {
  id: string;
  kind: 'overlay' | 'music' | 'sfx';
  label: string;
  start: number;
  end: number;
  source: string;
  in?: number;
  out?: number;
}

/** Everything an agent needs to act on one thread. */
export interface ContextBundle {
  assembly?: import('../assembly/index.js').AssemblyDraft;
  format: 'mdmedia.thread-context@2';
  thread: Thread;
  /** All of them, in order, including folded rounds. */
  messages: Message[];
  suggestions: Suggestion[];
  /** Where an agent writes, as API paths. */
  writeTo: { messages: string; suggestions: string; claim: string; status: string };
  production: { id: string; title: string; slug: string };
  version: {
    cutId: string;
    label: string;
    /** False when the cut has changed since the comment was made. */
    unchanged: boolean;
    title: string;
    length: number;
    fps: number | null;
    size: string;
    notes: string | null;
    /** The rendered video, as an asset id. */
    renderAssetId: string | null;
    /** The file the cut was pushed from, relative to the repository, when known. */
    sourceFile: string | null;
  };
  /** The anchor's items with absolute times (the playhead and range are on `thread.anchor`). Lines are by id, in `lines`. */
  anchored: {
    segments: BundleSegment[];
    lines: string[];
    gaps: BundleGap[];
    clips: BundleClip[];
  };
  /** The anchored lines and their neighbours, in speaking order, with their words on the timeline. */
  lines: BundleLine[];
  neighbours: {
    segments: Array<{ of: string; before: BundleSegment | null; after: BundleSegment | null; cuts: BundleCut[] }>;
    /** Line ids, in `lines`. */
    lines: Array<{ of: string; before: string | null; after: string | null; gapBefore: BundleGap | null; gapAfter: BundleGap | null }>;
  };
  decisions: { decisions: Decision[]; constraints: Decision[]; relevant: string[] };
  history: {
    status: string;
    note: string;
    versions: Array<{ id: string; label: string; status: string; kind: 'cut' | 'rendered' | 'assembly'; renderAssetId: string | null; current: boolean }>;
  };
  /** Asset ids, and API links to their bytes (`productions:read`). */
  media: {
    render: string | null;
    snapshot: string | null;
    previews: string[];
    links: Record<string, string>;
  };
  missing: Missing[];
}
