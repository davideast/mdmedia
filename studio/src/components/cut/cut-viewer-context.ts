'use client';

import { createContext, useContext, type RefObject } from 'react';
import type { Timeline } from 'mdmedia/cut';

/**
 * What the cut viewer lends the panels inside it: the playhead, seeking,
 * the video element and the frame the owner is watching in. The Comments
 * panel uses it to comment at the playhead and to jump to a comment's time.
 */
export interface CutViewerControls {
  /** The cut as resolved, words applied. */
  timeline: Timeline;
  currentTime: () => number;
  seek: (t: number) => void;
  pause: () => void;
  video: RefObject<HTMLVideoElement | null>;
  frame: 'tv' | 'full';
}

export const CutViewerContext = createContext<CutViewerControls | null>(null);

export function useCutViewer(): CutViewerControls {
  const controls = useContext(CutViewerContext);
  if (!controls) throw new Error('useCutViewer must be used inside the cut viewer.');
  return controls;
}

/** A comment's pin on the timeline. */
export interface CommentPin {
  id: string;
  time: number;
  tone: 'needs-you' | 'waiting' | 'working' | 'done';
  /** What a pointer or screen reader hears: the status and the comment's start. */
  label: string;
}

/** A status dot's colour by tone: amber when it needs the owner, green when resolved, quiet otherwise. The viewer is always dark. */
export const TONE_DOT: Record<CommentPin['tone'], string> = {
  'needs-you': 'bg-[#f5a524]',
  waiting: 'bg-ink-faint',
  working: 'bg-foreground/75',
  done: 'bg-[#3fb950]',
};

/** The Comments panel and its pins, as a page hands them to the viewer. */
export interface CutViewerComments {
  panel: React.ReactNode;
  pins: CommentPin[];
  selected: string | null;
  onPin: (id: string) => void;
  /** Where a comment being written will pin, if one is. */
  draft: number | null;
}
