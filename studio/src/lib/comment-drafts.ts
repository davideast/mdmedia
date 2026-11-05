/**
 * Unposted review comments and replies, kept in this browser as they are
 * typed so a reload, a closed box or a failed post never loses them. A new
 * comment is keyed by production, cut and the time it is about; a reply by
 * production and thread. A draft is cleared only once it has been posted, or
 * when the owner discards it.
 *
 * Storage can be missing or throw (private windows, blocked site data, a full
 * quota); every access is guarded, and without it drafts simply aren't kept.
 */

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type DraftTarget =
  | { kind: 'comment'; productionId: string; cutId: string; time: number }
  | { kind: 'reply'; productionId: string; threadId: string };

export interface UnsentComment {
  time: number;
  text: string;
  savedAt: number;
}

const PREFIX = 'mdmedia.comment-draft.v1';
const part = (value: string) => encodeURIComponent(value);
const commentPrefix = (productionId: string, cutId: string) => `${PREFIX}:comment:${part(productionId)}:${part(cutId)}:`;

export function draftKey(target: DraftTarget): string {
  return target.kind === 'comment'
    ? `${commentPrefix(target.productionId, target.cutId)}${target.time.toFixed(3)}`
    : `${PREFIX}:reply:${part(target.productionId)}:${part(target.threadId)}`;
}

/** This browser's localStorage, or null where it can't be reached. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): { text: string; savedAt: number } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { text, savedAt } = value as { text?: unknown; savedAt?: unknown };
    return typeof text === 'string' && text ? { text, savedAt: typeof savedAt === 'number' ? savedAt : 0 } : null;
  } catch {
    return null;
  }
}

export function readDraft(target: DraftTarget, storage: DraftStorage | null = browserStorage()): string {
  try {
    return parse(storage?.getItem(draftKey(target)) ?? null)?.text ?? '';
  } catch {
    return '';
  }
}

/** Keeps the text as typed; blank text removes the draft. Returns whether it was kept. */
export function saveDraft(target: DraftTarget, text: string, storage: DraftStorage | null = browserStorage(), now = Date.now()): boolean {
  if (!storage) return false;
  try {
    if (!text.trim()) storage.removeItem(draftKey(target));
    else storage.setItem(draftKey(target), JSON.stringify({ text, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(target: DraftTarget, storage: DraftStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(draftKey(target));
  } catch {
    // Nothing more to do: the draft stays until storage works again.
  }
}

/** A cut's unposted new comments, earliest time first. */
export function unsentComments(productionId: string, cutId: string, storage: DraftStorage | null = browserStorage()): UnsentComment[] {
  if (!storage) return [];
  const prefix = commentPrefix(productionId, cutId);
  const found: UnsentComment[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const time = Number(key.slice(prefix.length));
      const draft = parse(storage.getItem(key));
      if (draft && Number.isFinite(time)) found.push({ time, ...draft });
    }
  } catch {
    return found;
  }
  return found.sort((a, b) => a.time - b.time);
}
