/** An independent story plan. Board and Script edit the same document. */
export interface StoryBeat {
  id: string;
  title: string;
  purpose: string;
  /** A concise walkthrough of this moment, separate from verbatim narration. */
  summary?: string;
  script: string;
  visual: string;
  /** Optional local concept artwork, separate from production footage. */
  image?: string;
  notes: string;
  status: 'draft' | 'decided';
  estimatedSeconds: number | null;
}

export interface StoryboardDocument {
  version: 1;
  premise: string;
  beats: StoryBeat[];
}

export interface SavedStoryboard {
  revision: number;
  updatedAt: number;
  document: StoryboardDocument;
}

export interface StoryboardResource {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  storyboard: SavedStoryboard | null;
}

export type StoryboardView = 'board' | 'script';
export const storyboardView = (value: string | null): StoryboardView => value === 'script' ? 'script' : 'board';
export const storyboardPath = (id: string) => `/storyboards/${encodeURIComponent(id)}`;

export function storyboardHref(id: string, view: StoryboardView = 'board', beat?: string | null): string {
  const search = new URLSearchParams({ view });
  if (beat) search.set('beat', beat);
  return `${storyboardPath(id)}?${search}`;
}

export function emptyStoryboard(): StoryboardDocument { return { version: 1, premise: '', beats: [] }; }
export function newBeat(id: string): StoryBeat {
  return { id, title: 'New beat', purpose: '', script: '', visual: '', notes: '', status: 'draft', estimatedSeconds: null };
}

/** Reorder by identity, preserving all of a beat's content. */
export function moveBeat(document: StoryboardDocument, id: string, direction: -1 | 1): StoryboardDocument {
  const index = document.beats.findIndex(beat => beat.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= document.beats.length) return document;
  const beats = [...document.beats];
  [beats[index], beats[target]] = [beats[target], beats[index]];
  return { ...document, beats };
}

/** Strict boundary for API and agent-authored imports. Unknown fields are rejected, never silently discarded. */
export function parseStoryboard(value: unknown, allowUntitled = false): StoryboardDocument {
  return parseDocument(value, allowUntitled, false);
}

/** Recover authored work even when it exceeds save limits. Shape, IDs and image
 * safety still apply; persistence validation must never discard a local draft. */
export function restoreStoryboardDraft(value: unknown): StoryboardDocument {
  return parseDocument(value, true, true);
}

function parseDocument(value: unknown, allowUntitled: boolean, recovering: boolean): StoryboardDocument {
  const record = (value: unknown, fields: string[], name: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    const result = value as Record<string, unknown>;
    if (Object.keys(result).some(key => !fields.includes(key))) throw new Error(`${name} contains an unsupported field.`);
    return result;
  };
  const text = (value: unknown, field: string, max: number, required = false) => {
    if (typeof value !== 'string' || (!recovering && value.length > max) || (required && !value.trim())) throw new Error(`${field} must be ${required ? 'non-empty ' : ''}text, at most ${max} characters.`);
    return value;
  };
  const raw = record(value, ['version', 'premise', 'beats'], 'Storyboard');
  if (raw.version !== 1) throw new Error('Unsupported storyboard version. Expected version 1.');
  if (!Array.isArray(raw.beats) || (!recovering && raw.beats.length > 100)) throw new Error('A storyboard can contain up to 100 beats.');
  const ids = new Set<string>();
  const document: StoryboardDocument = {
    version: 1,
    premise: text(raw.premise, 'Premise', 4000),
    beats: raw.beats.map(value => {
      const beat = record(value, ['id', 'title', 'purpose', 'script', 'visual', 'notes', 'status', 'estimatedSeconds', 'image', 'summary'], 'Beat');
      const id = text(beat.id, 'Beat id', 80, true);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error('Beat ids must be unique letters, numbers, underscores or hyphens.');
      ids.add(id);
      if (beat.status !== 'draft' && beat.status !== 'decided') throw new Error('Beat status must be draft or decided.');
      if (beat.estimatedSeconds !== null && (typeof beat.estimatedSeconds !== 'number' || !Number.isFinite(beat.estimatedSeconds) || beat.estimatedSeconds <= 0 || beat.estimatedSeconds > 3600)) throw new Error('Estimated seconds must be null or a number greater than zero and at most 3600.');
      if (beat.image !== undefined && (typeof beat.image !== 'string' || !/^\/assets\/storyboard\/[a-zA-Z0-9_-]+\.(png|webp|jpg)$/.test(beat.image))) throw new Error('Concept image must be a local storyboard asset.');
      return { ...(beat.summary !== undefined ? { summary: text(beat.summary, 'Summary', 1200) } : {}), ...(beat.image ? { image: beat.image as string } : {}), id, title: text(beat.title, 'Title', 200, !allowUntitled), purpose: text(beat.purpose, 'Purpose', 2000), script: text(beat.script, 'Script', 8000), visual: text(beat.visual, 'Visual', 4000), notes: text(beat.notes, 'Notes', 4000), status: beat.status, estimatedSeconds: beat.estimatedSeconds };
    }),
  };
  if (!recovering && new TextEncoder().encode(JSON.stringify(document)).length > 160_000) throw new Error('Storyboard is too large (maximum 160 KB).');
  return document;
}

export interface StoryboardSummary { id: string; title: string; beatCount: number; image: string | null; updatedAt: number }

export function storyboardRoute(path: string): string | null {
  const match = /^\/storyboards\/([^/?#]+)\/?$/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}
