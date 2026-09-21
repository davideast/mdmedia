"use client";

import { cn } from "cn";
import { memo, useMemo, type CSSProperties } from "react";
import { useNarration } from "@/components/shell/narration-provider";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  type AlignedWord,
  type HighlightColorId,
} from "@/lib/types";

export interface ReaderBlock {
  key: string;
  kind: "h1" | "h2" | "h3" | "quote" | "bullet" | "p";
  /** Absolute offset of `text` within the transcript. */
  start: number;
  text: string;
}

/**
 * Split a transcript into renderable blocks while keeping exact character
 * offsets.
 *
 * Offsets have to survive rendering, because the narration marker is addressed
 * by character range. So block-level syntax is recognised by its prefix and the
 * prefix length is added back into `start` — nothing is reflowed, and no inline
 * parsing runs that could desynchronise the mapping.
 *
 * This is safe in practice because the transcript is what mdmedia's chunker
 * produced, and the chunker has already reduced the source to speakable prose.
 */
export function toReaderBlocks(transcript: string): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  let cursor = 0;

  for (const raw of transcript.split("\n\n")) {
    const leading = raw.length - raw.trimStart().length;
    const body = raw.trim();
    const start = cursor + leading;
    cursor += raw.length + 2;

    if (body.length === 0) continue;

    const prefixed = (marker: string, kind: ReaderBlock["kind"]) => ({
      key: `b${start}`,
      kind,
      start: start + marker.length,
      text: body.slice(marker.length),
    });

    if (body.startsWith("### ")) blocks.push(prefixed("### ", "h3"));
    else if (body.startsWith("## ")) blocks.push(prefixed("## ", "h2"));
    else if (body.startsWith("# ")) blocks.push(prefixed("# ", "h1"));
    else if (body.startsWith("> ")) blocks.push(prefixed("> ", "quote"));
    else if (body.startsWith("- ")) blocks.push(prefixed("- ", "bullet"));
    else if (body.startsWith("* ")) blocks.push(prefixed("* ", "bullet"));
    else blocks.push({ key: `b${start}`, kind: "p", start, text: body });
  }

  return blocks;
}

const BLOCK_CLASS: Record<ReaderBlock["kind"], string> = {
  h1: "t-h1 pt-4",
  h2: "t-h2 pt-3",
  h3: "font-display text-[1.05rem] font-semibold leading-snug pt-2",
  quote: "pl-5 text-ink-muted italic",
  bullet: "pl-5",
  p: "",
};

interface TextSegment {
  text: string;
  isWord: boolean;
  absStart: number;
  absEnd: number;
}

function splitBlockSegments(block: ReaderBlock): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /(\S+|\s+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(block.text)) !== null) {
    const token = match[0];
    const absStart = block.start + match.index;
    const absEnd = absStart + token.length;
    segments.push({
      text: token,
      isWord: !/^\s+$/.test(token),
      absStart,
      absEnd,
    });
  }

  return segments;
}

function findAlignedWord(
  words: readonly AlignedWord[],
  absStart: number,
  absEnd: number,
): AlignedWord | undefined {
  let low = 0;
  let high = words.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const current = words[mid];
    if (current.charEnd <= absStart) {
      low = mid + 1;
    } else if (current.charStart >= absEnd) {
      high = mid - 1;
    } else {
      return current;
    }
  }

  return undefined;
}

function BlockBody({
  block,
  activeFrom,
  activeTo,
  words,
  audioLoaded,
  loadedDurationMs,
  onSeekWord,
}: {
  block: ReaderBlock;
  activeFrom: number;
  activeTo: number;
  words: readonly AlignedWord[];
  audioLoaded: boolean;
  loadedDurationMs: number;
  onSeekWord?: (startMs: number) => void;
}) {
  const segments = useMemo(() => splitBlockSegments(block), [block]);

  return (
    <>
      {segments.map((segment) => {
        if (!segment.isWord) {
          return <span key={segment.absStart}>{segment.text}</span>;
        }

        const isActive = activeFrom < segment.absEnd && activeTo > segment.absStart;
        const aligned = findAlignedWord(words, segment.absStart, segment.absEnd);
        const canSeek =
          audioLoaded &&
          onSeekWord !== undefined &&
          aligned !== undefined &&
          aligned.startMs <= loadedDurationMs;

        if (canSeek) {
          return (
            <span
              key={segment.absStart}
              role="button"
              tabIndex={0}
              data-word-selectable="true"
              data-word-active={isActive ? "true" : undefined}
              onClick={() => onSeekWord(aligned.startMs)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSeekWord(aligned.startMs);
                }
              }}
              className={cn(
                "cursor-pointer rounded-[3px] px-[1px] -mx-[1px] transition-colors",
                isActive
                  ? "reader-word-active"
                  : "hover:bg-foreground/10 active:bg-foreground/20",
              )}
            >
              {segment.text}
            </span>
          );
        }

        return (
          <span
            key={segment.absStart}
            aria-disabled="true"
            data-word-selectable="false"
            data-word-active={isActive ? "true" : undefined}
            className={cn(
              "cursor-default select-none",
              isActive ? "reader-word-active" : undefined,
            )}
          >
            {segment.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * The reading surface.
 *
 * Blocks fade in as synthesis produces them, and the word currently being
 * spoken is marked inline with the user's selected accessible highlight color.
 * Words with loaded audio are interactive and seek the audio player when clicked;
 * words without loaded audio are disabled and non-selectable.
 */
export const Reader = memo(function Reader({
  transcript,
  activeCharStart,
  activeCharEnd,
  spokenThrough,
  words = [],
  audioLoaded = false,
  loadedDurationMs = 0,
  onSeekWord,
  highlightColor,
  className,
}: {
  transcript: string;
  activeCharStart: number | null;
  activeCharEnd: number | null;
  /** Character offset the narration has reached. Everything after is unspoken. */
  spokenThrough: number;
  words?: readonly AlignedWord[];
  audioLoaded?: boolean;
  loadedDurationMs?: number;
  onSeekWord?: (startMs: number) => void;
  highlightColor?: HighlightColorId;
  className?: string;
}) {
  const { highlightColor: contextHighlightColor } = useNarration();
  const blocks = useMemo(() => toReaderBlocks(transcript), [transcript]);

  const effectiveColorId =
    highlightColor ?? contextHighlightColor ?? DEFAULT_HIGHLIGHT_COLOR;
  const preset =
    HIGHLIGHT_COLORS.find((item) => item.id === effectiveColorId) ?? HIGHLIGHT_COLORS[0];

  const highlightVars = {
    "--reader-highlight-bg": preset.bg,
    "--reader-highlight-fg": preset.text,
  } as CSSProperties;

  const from = activeCharStart ?? -1;
  const to = activeCharEnd ?? -1;

  return (
    <article
      style={highlightVars}
      className={cn(
        "mx-auto grid w-full max-w-[68ch] gap-5 text-[1.0625rem] leading-[1.68] text-foreground",
        className,
      )}
    >
      {blocks.map((block) => (
        <div
          key={block.key}
          data-spoken={block.start <= spokenThrough}
          className={cn("reader-block", BLOCK_CLASS[block.kind])}
        >
          <BlockBody
            block={block}
            activeFrom={from}
            activeTo={to}
            words={words}
            audioLoaded={audioLoaded}
            loadedDurationMs={loadedDurationMs}
            onSeekWord={onSeekWord}
          />
        </div>
      ))}
    </article>
  );
});
