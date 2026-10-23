import type { CastId, SourceRange } from '../types.js';

export type ComicItem =
  /** A caption box: the narrator. */
  | { kind: 'caption'; cue: string; text: string; display: string; source: SourceRange }
  /** A balloon; `mark` is how it is lettered, `cue` how it sounds. */
  | { kind: 'balloon'; who: CastId; cue: string; mark?: 'small' | 'off' | 'loud'; text: string; display: string; source: SourceRange }
  /** A sound effect lettered into the art. */
  | { kind: 'sfx'; text: string; source: SourceRange };

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComicPanel {
  /** `page.index`, such as `3.2`. */
  id: string;
  page: number;
  index: number;
  slot: Slot;
  /** The nearest aspect ratio the image model draws. */
  aspect: string;
  /** What to draw, without the position and balloon markers. */
  shot: string;
  /** What the moment means, written in context. */
  acting: string;
  /** Who stands where. */
  positions: Record<CastId, 'left' | 'center' | 'right'>;
  /** Where the lettering goes, kept clear of faces in the art. */
  zone: 'top' | 'bottom';
  /** The panel this one is an edit of: same face and framing. */
  continues?: string;
  /** In force on this page: the room, its staging, the continuity rules. */
  setting?: string;
  staging?: string;
  rules?: string;
  items: ComicItem[];
  source: SourceRange;
}

export interface ComicPage {
  index: number;
  /** Rows of panel weights. */
  layout: number[][];
  panels: ComicPanel[];
}

export interface ComicScript {
  schema: 'mdmedia.story.comic/1';
  source: { path: string; sha256: string };
  meta: { title: string; story: string; style: string; setting?: string; staging?: string; rules?: string };
  page: { width: number; height: number; gutter: number };
  pages: ComicPage[];
}
