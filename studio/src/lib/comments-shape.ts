/**
 * Comments' stored documents read back into `mdmedia/threads` shapes, field
 * by field, so a missing or odd field never breaks a page or a route. Pure:
 * the API reads with it, and so does the cut viewer's live listener.
 */

import {
  DECISION_SOURCES,
  SUGGESTION_STATES,
  THREAD_STATUSES,
  type AnchorItem,
  type Decision,
  type DecisionSource,
  type Message,
  type Preview,
  type Suggestion,
  type SuggestionCheck,
  type SuggestionState,
  type Thread,
  type ThreadStatus,
  type TimedRef,
} from 'mdmedia/threads';

/** A stored document, before it is checked. */
type Data = Record<string, unknown> | undefined;

export const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
export const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly unknown[]).includes(value) ? (value as T) : fallback);
const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>));
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function readItems(value: unknown): AnchorItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    return typeof item.kind === 'string' && typeof item.id === 'string'
      ? [{ kind: item.kind as AnchorItem['kind'], id: item.id, start: num(item.start), end: num(item.end) }]
      : [];
  });
}

function readVideo(value: unknown): TimedRef['video'] | null {
  const video = record(value);
  if (video.kind === 'cut' && typeof video.cutId === 'string') return { kind: 'cut', cutId: video.cutId };
  if (video.kind === 'preview' && typeof video.suggestionId === 'string' && typeof video.assetId === 'string') return { kind: 'preview', suggestionId: video.suggestionId, assetId: video.assetId };
  return null;
}

export function readThread(id: string, data: Data): Thread {
  const anchor = record(data?.anchor);
  const range = record(anchor.range);
  const version = record(data?.version);
  const claim = record(data?.claim);
  const snapshot = data?.snapshot && typeof data.snapshot === 'object' ? (data.snapshot as Thread['snapshot']) : null;
  return {
    id,
    productionId: str(data?.productionId),
    version: { cutId: str(version.cutId, str(data?.cutId)), cutUpdatedAt: typeof version.cutUpdatedAt === 'number' ? version.cutUpdatedAt : null },
    anchor: {
      time: num(anchor.time),
      ...(typeof range.start === 'number' && typeof range.end === 'number' ? { range: { start: range.start, end: range.end, why: str(range.why) } } : {}),
      items: readItems(anchor.items),
    },
    snapshot,
    text: str(data?.text),
    author: str(data?.author, 'owner'),
    status: oneOf<ThreadStatus>(data?.status, THREAD_STATUSES, 'open'),
    claim: typeof claim.agent === 'string' ? { agent: claim.agent, at: num(claim.at), expiresAt: num(claim.expiresAt) } : null,
    createdAt: num(data?.createdAt),
    updatedAt: num(data?.updatedAt),
  };
}

export function readMessage(id: string, data: Data): Message {
  const at = record(data?.at);
  const video = readVideo(at.video);
  const version = record(data?.version);
  const suggestions = strings(data?.suggestions);
  return {
    id,
    threadId: str(data?.threadId),
    author: str(data?.author, 'owner'),
    text: str(data?.text),
    ...optional('replyTo', text(data?.replyTo)),
    ...(suggestions.length ? { suggestions } : {}),
    ...(video && typeof at.time === 'number' ? { at: { video, time: at.time, ...(Array.isArray(at.anchor) ? { anchor: readItems(at.anchor) } : {}) } } : {}),
    ...(typeof version.cutId === 'string' ? { version: { cutId: version.cutId } } : {}),
    createdAt: num(data?.createdAt),
  };
}

export function readSuggestion(id: string, data: Data): Suggestion {
  const cost = record(data?.cost);
  const previews: Preview[] = Array.isArray(data?.previews)
    ? data.previews.flatMap((raw) => {
      const p = record(raw);
      return typeof p.assetId === 'string'
        ? [{ assetId: p.assetId, ...optional('label', text(p.label)), ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}) }]
        : [];
    })
    : [];
  return {
    id,
    threadId: str(data?.threadId),
    author: str(data?.author, 'agent:agent'),
    round: num(data?.round, 1),
    letter: str(data?.letter, 'A'),
    title: str(data?.title),
    approach: str(data?.approach),
    steps: strings(data?.steps),
    cost: { generations: num(cost.generations), minutes: num(cost.minutes) },
    risks: strings(data?.risks),
    checks: Array.isArray(data?.checks) ? (data.checks as SuggestionCheck[]) : [],
    previews,
    keeps: strings(data?.keeps),
    overturns: strings(data?.overturns),
    creates: strings(data?.creates),
    ...optional('revises', text(data?.revises)),
    state: oneOf<SuggestionState>(data?.state, SUGGESTION_STATES, 'proposed'),
    ...optional('appliedAs', text(data?.appliedAs)),
    ...(typeof data?.stateChangedAt === 'number' ? { stateChangedAt: data.stateChangedAt } : {}),
    ...optional('stateChangedBy', text(data?.stateChangedBy)),
    createdAt: num(data?.createdAt),
  };
}

export function readDecision(id: string, data: Data): Decision {
  return {
    id,
    kind: data?.kind === 'constraint' ? 'constraint' : 'decision',
    ...optional('take', text(data?.take)),
    ...((DECISION_SOURCES as readonly unknown[]).includes(data?.source) ? { source: data?.source as DecisionSource } : {}),
    ...optional('quote', text(data?.quote)),
    text: str(data?.text),
    ...optional('revised', text(data?.revised)),
    threadIds: strings(data?.threadIds),
    cutIds: strings(data?.cutIds),
    order: num(data?.order),
    createdAt: num(data?.createdAt),
  };
}
