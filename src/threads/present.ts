import type { ResolvedLine, Timeline } from '../cut/types.js';
import { anchorItems, itemSpan, linePlace, spokenLines, spokenSpan } from './anchor.js';
import type { AgentHeartbeat, AnchorItem, ItemRef, Preview, SnapshotWord, Suggestion, Thread, TimedRef } from './types.js';
import { HEARTBEAT_FRESH_MS } from './types.js';

/**
 * How comments read, wherever they are shown: Studio's Comments panel, the
 * CLI, an agent's context. Pure, so the server, the page and the CLI agree.
 */

const ms = (n: number): number => Math.round(n * 1000) / 1000;

/** The anchor for a playhead at `t`: {@link anchorItems}, each with its span on the timeline now. */
export function anchorAt(timeline: Timeline, t: number): AnchorItem[] {
  return anchorItems(timeline, t).map((ref) => {
    const span = itemSpan(timeline, ref);
    return { ...ref, start: span ? ms(span.start) : t, end: span ? ms(span.end) : t };
  });
}

/** Words heard within `window` seconds either side of `t`, in order. */
export function wordsAround(timeline: Timeline, t: number, window = 2): SnapshotWord[] {
  const words: SnapshotWord[] = [];
  for (const { line } of spokenLines(timeline)) {
    for (const w of line.words) if (w.end > t - window && w.start < t + window) words.push({ line: line.id, text: w.text, start: w.start, end: w.end });
  }
  return words.sort((a, b) => a.start - b.start);
}

/** Overlays on screen at `t`. */
export const overlaysAt = (timeline: Timeline, t: number): string[] => timeline.overlays.filter((o) => t >= o.start && t < o.end).map((o) => o.id);

/** A line's words for a sentence, shortened past six words: “And this one? This one…”. */
export function quoteLine(text: string, words = 6): string {
  const parts = text.trim().split(/\s+/);
  const short = parts.length > words ? `${parts.slice(0, words - 1).join(' ')}…` : parts.join(' ');
  return `“${short}”`;
}

/**
 * Where a comment is, in plain words: `during “Wheels!” · finish shot`, or
 * `in the pause before “PERSONALLY!” · pat shot`. Read from the cut as it is
 * now when there is one, else from the anchor's own items (ids only).
 */
export function anchorPhrase(timeline: Timeline | null, items: readonly ItemRef[], t: number): string {
  const parts: string[] = [];
  const line = (id: string): ResolvedLine | undefined => timeline?.lines.find((l) => l.id === id);
  if (timeline) {
    const place = linePlace(timeline, t);
    if (place.in === 'line') parts.push(`during ${quoteLine(line(place.line)?.text ?? place.line)}`);
    else if (place.in === 'gap') parts.push(`in the pause before ${quoteLine(line(place.gap.to)?.text ?? place.gap.to)}`);
    else if (place.after) parts.push(`before ${quoteLine(line(place.after)?.text ?? place.after)}`);
    else if (place.before) parts.push(`after ${quoteLine(line(place.before)?.text ?? place.before)}`);
    const segment = timeline.segments.find((s) => t >= s.start && t < s.end) ?? (t >= timeline.length ? timeline.segments.at(-1) : undefined);
    if (segment) parts.push(`${segment.id} shot`);
  } else {
    // Without the cut, the items' own times (when they have them) say which one the playhead was in.
    const at = (i: ItemRef) => !('start' in i) || ((i as AnchorItem).start <= t && t < (i as AnchorItem).end);
    const line = items.find((i) => i.kind === 'line' && 'start' in i && at(i));
    const gap = items.find((i) => i.kind === 'gap' && at(i));
    if (line) parts.push(`during line ${line.id}`);
    else if (gap) parts.push(`in the pause before line ${gap.id.split('-')[1]}`);
    else {
      const first = items.find((i) => i.kind === 'line');
      if (first) parts.push(`near line ${first.id}`);
    }
    const segment = items.find((i) => i.kind === 'segment');
    if (segment) parts.push(`${segment.id} shot`);
  }
  return parts.join(' · ');
}

/** Seconds as the viewer shows them: `15.0 s`. */
export function seconds(t: number): string {
  return `${(Math.round(t * 10 + 1e-6) / 10).toFixed(1)} s`;
}

/** Letters for options within a round: A, B, … Z, AA. */
export function optionLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** `Option A · round 2`. */
export const optionLabel = (s: Pick<Suggestion, 'letter' | 'round'>): string => `Option ${s.letter} · round ${s.round}`;

/** A preview's plain label: the option's, then what tells it from the option's other previews. */
export function previewLabel(s: Pick<Suggestion, 'letter' | 'round' | 'previews'>, assetId: string): string {
  const index = s.previews.findIndex((p) => p.assetId === assetId);
  const preview: Preview | undefined = s.previews[index];
  if (index <= 0 && !preview?.label) return optionLabel(s);
  return `${optionLabel(s)} · ${preview?.label ?? `preview ${index + 1}`}`;
}

/** "Take 9 (opens on the road)" reads as "Take 9". */
export const shortCutLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;

/**
 * Which video a time is on, and the time: `Take 5 · 21.8 s`,
 * `Option A · round 2 · 15.0 s`. `cutLabel` names a cut by id; `suggestion`
 * finds a preview's option.
 */
export function timedLabel(at: TimedRef, cutLabel: (cutId: string) => string, suggestion: (id: string) => Suggestion | undefined): string {
  return `${videoLabel(at.video, cutLabel, suggestion)} · ${seconds(at.time)}`;
}

export function videoLabel(video: TimedRef['video'], cutLabel: (cutId: string) => string, suggestion: (id: string) => Suggestion | undefined): string {
  if (video.kind === 'cut') return cutLabel(video.cutId);
  const s = suggestion(video.suggestionId);
  return s ? previewLabel(s, video.assetId) : 'A preview';
}

/** Whether an agent holds the thread now. */
export const isClaimed = (thread: Pick<Thread, 'claim'>, now = Date.now()): boolean => Boolean(thread.claim && thread.claim.expiresAt > now);

/** Whether an agent is watching for comments on this production now. */
export function agentPresent(heartbeats: readonly AgentHeartbeat[], productionId: string, now = Date.now()): boolean {
  return heartbeats.some((h) => (h.productionId === null || h.productionId === productionId) && now - h.seenAt < HEARTBEAT_FRESH_MS);
}

/** The latest round's options that still wait for the owner: proposed, in a round where none was taken. */
export function waitingOptions(suggestions: readonly Suggestion[]): Suggestion[] {
  const latest = Math.max(0, ...suggestions.map((s) => s.round));
  const round = suggestions.filter((s) => s.round === latest);
  if (round.some((s) => s.state === 'accepted' || s.state === 'applied')) return [];
  return round.filter((s) => s.state === 'proposed').sort((a, b) => a.letter.localeCompare(b.letter));
}

export type StatusTone = 'needs-you' | 'waiting' | 'working' | 'done';

/**
 * A thread's one status line: what it waits for, in words, and a tone for its
 * dot. Read from the thread's status, its claim and its options' states.
 */
export function statusLine(
  thread: Pick<Thread, 'status' | 'claim'>,
  suggestions: readonly Suggestion[],
  cutLabel: (cutId: string) => string,
  now = Date.now(),
): { tone: StatusTone; text: string } {
  if (thread.status === 'resolved') return { tone: 'done', text: 'Resolved' };
  if (isClaimed(thread, now)) return { tone: 'working', text: 'Agent working' };
  const accepted = suggestions.filter((s) => s.state === 'accepted').sort((a, b) => (b.stateChangedAt ?? 0) - (a.stateChangedAt ?? 0))[0];
  if (accepted) return { tone: 'waiting', text: `You accepted ${optionLabel(accepted)}` };
  if (thread.status === 'open') return { tone: 'waiting', text: 'Waiting for an agent' };
  if (thread.status === 'in-progress') return { tone: 'waiting', text: 'In progress' };
  const waiting = waitingOptions(suggestions);
  if (waiting.length) return { tone: 'needs-you', text: waiting.length === 1 ? '1 option to review' : `${waiting.length} options to review` };
  const applied = suggestions.filter((s) => s.state === 'applied' && s.appliedAs).sort((a, b) => (b.stateChangedAt ?? 0) - (a.stateChangedAt ?? 0))[0];
  if (applied?.appliedAs) return { tone: 'needs-you', text: `Addressed in ${cutLabel(applied.appliedAs)}` };
  return { tone: 'needs-you', text: 'The agent replied' };
}

/** A line's spoken span, re-exported for callers that only need this module. */
export { spokenSpan };
