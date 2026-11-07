"use client";

import {
  Fragment,
  useMemo,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from "react";
import { lexer, type Token, type Tokens } from "marked";
import {
  AudioLines,
  Clock,
  FileText,
  Film,
  ImageIcon,
  Music,
  ScanSearch,
  Volume2,
} from "lucide-react";
import { cn } from "cn";
import { CodeBlock } from "@/components/reader/code-block";
import { parseTimestamp, splitTimestamps } from "@/lib/analysis-draft";
import { seekActiveChatSurface } from "@/lib/chat-context-bridge";
import {
  defaultEntityPillLabel,
  isMediaReferenceKind,
  parseChatEntityUri,
} from "@/lib/chat/references";
import type { ChatMediaType, ChatReferenceKind } from "@/lib/chat/types";
import { ChatReferenceChip } from "./chat-reference-chip";
import {
  alignMarkdownWords,
  normalizeSpeakableToken,
} from "@/lib/markdown-word-aligner";
import type { TranscriptSourceMap } from "@/lib/tree-types";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  type AlignedChunk,
  type AlignedWord,
  type HighlightColorId,
} from "@/lib/types";

const HEADING_CLASSES: Record<number, string> = {
  1: "font-display text-[1.1rem] font-semibold leading-snug",
  2: "font-display text-[1rem] font-semibold leading-snug",
  3: "font-display text-[0.92rem] font-semibold leading-snug",
  4: "text-[0.875rem] font-semibold leading-snug",
  5: "text-[0.82rem] font-semibold leading-snug text-ink-muted",
  6: "text-[0.78rem] font-semibold uppercase tracking-wider text-ink-muted",
};

const VALID_CHAT_MEDIA_TYPES = new Set<ChatMediaType>([
  "narration",
  "video",
  "image",
  "music",
  "sfx",
  "analysis",
]);

function getChatHighlightPalette(colorId?: HighlightColorId): {
  bg: string;
  text: string;
} {
  const effectiveId = colorId ?? DEFAULT_HIGHLIGHT_COLOR;
  return (
    HIGHLIGHT_COLORS.find((item) => item.id === effectiveId) ??
    HIGHLIGHT_COLORS[0]
  );
}

export interface ParsedChatMediaLink {
  mediaType: ChatMediaType;
  itemId: string;
  generationId?: string;
  href: string;
}

export function mediaRouteForItem(mediaType: ChatMediaType, itemId: string): string {
  const encoded = encodeURIComponent(itemId);
  switch (mediaType) {
    case "narration":
      return `/narration/${encoded}`;
    case "video":
      return `/video/${encoded}`;
    case "image":
      return `/image/${encoded}`;
    case "music":
      return `/music/${encoded}`;
    case "analysis":
      return `/analysis/${encoded}`;
    case "sfx":
      return "/library?type=sfx";
  }
}

/**
 * Browser-safe parser for `mdmedia://<type>/<id>[@<generationId>]` URIs.
 */
export function parseChatMediaLink(rawHref: string): ParsedChatMediaLink | null {
  const trimmed = rawHref.trim();
  if (!trimmed.toLowerCase().startsWith("mdmedia://")) return null;
  const body = trimmed.slice("mdmedia://".length);
  const slashIdx = body.indexOf("/");
  if (slashIdx <= 0) return null;

  const rawType = body.slice(0, slashIdx).toLowerCase() as ChatMediaType;
  if (!VALID_CHAT_MEDIA_TYPES.has(rawType)) return null;

  const rest = body.slice(slashIdx + 1).trim();
  if (!rest || /\s/.test(rest)) return null;

  const atIdx = rest.indexOf("@");
  if (atIdx !== -1) {
    const itemId = rest.slice(0, atIdx).trim();
    const generationId = rest.slice(atIdx + 1).trim();
    if (!itemId) return null;
    return {
      mediaType: rawType,
      itemId,
      ...(generationId ? { generationId } : {}),
      href: mediaRouteForItem(rawType, itemId),
    };
  }

  return {
    mediaType: rawType,
    itemId: rest,
    href: mediaRouteForItem(rawType, rest),
  };
}

export type InlineChatSegment =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      raw: string;
      mediaType: ChatMediaType;
      itemId: string;
      generationId?: string;
      href: string;
      label: string;
    }
  | {
      kind: "entity";
      raw: string;
      entityKind: Exclude<ChatReferenceKind, ChatMediaType>;
      id: string;
      subId?: string;
      href: string;
      label: string;
    }
  | {
      kind: "route";
      raw: string;
      href: string;
      label: string;
    }
  | {
      kind: "timestamp";
      label: string;
      seconds: number;
    };

const INLINE_REF_PATTERN =
  /(mdmedia:\/\/[a-zA-Z-]+\/[A-Za-z0-9._@/%-]+)|((?<![A-Za-z0-9_:/])\/(?:trees|analysis|video|image|music|narration|library|studio|queue|playlists|storyboards|productions|drafts|pinned|recent|settings)(?:\/[A-Za-z0-9._~:/?#[\]@!$&'*+,;=%-]*)?)/g;

function stripTrailingSentencePunctuation(token: string): {
  clean: string;
  trailing: string;
} {
  let clean = token;
  let trailing = "";
  while (clean.length > 1 && /[.,;:!?)\]]$/.test(clean)) {
    trailing = clean.slice(-1) + trailing;
    clean = clean.slice(0, -1);
  }
  return { clean, trailing };
}

function defaultMediaPillLabel(mediaType: ChatMediaType, itemId: string): string {
  const prefix =
    mediaType === "analysis"
      ? "Analysis"
      : mediaType === "narration"
        ? "Narration"
        : mediaType === "video"
          ? "Video"
          : mediaType === "image"
            ? "Image"
            : mediaType === "music"
              ? "Music"
              : "SFX";
  const shortId = itemId.length > 14 ? `${itemId.slice(0, 12)}…` : itemId;
  return `${prefix} · ${shortId}`;
}

function appendTextWithTimestamps(slice: string, out: InlineChatSegment[]): void {
  if (!slice) return;
  const parts = splitTimestamps(slice);
  for (const part of parts) {
    if (typeof part === "string") {
      if (!part) continue;
      const prev = out[out.length - 1];
      if (prev && prev.kind === "text") {
        prev.text += part;
      } else {
        out.push({ kind: "text", text: part });
      }
    } else {
      const parsed = parseTimestamp(part.label);
      if (parsed !== null) {
        out.push({ kind: "timestamp", label: part.label, seconds: parsed });
      } else {
        out.push({ kind: "text", text: part.label });
      }
    }
  }
}

/**
 * Splits plain text into safe text runs, `mdmedia://` pills, internal Studio
 * route pills (`/trees/...`, `/analysis/...`), and clickable `MM:SS` / `H:MM:SS`
 * seek timestamps.
 */
export function tokenizeInlineChatSegments(text: string): InlineChatSegment[] {
  if (!text) return [];
  const segments: InlineChatSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_REF_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      appendTextWithTimestamps(text.slice(cursor, matchIndex), segments);
    }

    const rawToken = match[0];
    const { clean, trailing } = stripTrailingSentencePunctuation(rawToken);

    if (clean.toLowerCase().startsWith("mdmedia://")) {
      const parsedMedia = parseChatMediaLink(clean);
      if (parsedMedia) {
        segments.push({
          kind: "media",
          raw: clean,
          mediaType: parsedMedia.mediaType,
          itemId: parsedMedia.itemId,
          ...(parsedMedia.generationId ? { generationId: parsedMedia.generationId } : {}),
          href: parsedMedia.href,
          label: defaultMediaPillLabel(parsedMedia.mediaType, parsedMedia.itemId),
        });
      } else {
        const parsedEntity = parseChatEntityUri(clean);
        if (parsedEntity && !isMediaReferenceKind(parsedEntity.kind)) {
          segments.push({
            kind: "entity",
            raw: clean,
            entityKind: parsedEntity.kind,
            id: parsedEntity.id,
            ...(parsedEntity.subId ? { subId: parsedEntity.subId } : {}),
            href: parsedEntity.href,
            label: defaultEntityPillLabel(parsedEntity),
          });
        } else {
          appendTextWithTimestamps(clean, segments);
        }
      }
    } else if (clean.startsWith("/") && !clean.startsWith("//")) {
      segments.push({
        kind: "route",
        raw: clean,
        href: clean,
        label: clean,
      });
    } else {
      appendTextWithTimestamps(clean, segments);
    }

    if (trailing) {
      appendTextWithTimestamps(trailing, segments);
    }
    cursor = matchIndex + rawToken.length;
  }

  if (cursor < text.length) {
    appendTextWithTimestamps(text.slice(cursor), segments);
  }

  return segments;
}

function isExternalSafeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

function isInternalStudioRoute(href: string): boolean {
  const trimmed = href.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/api/");
}

function MediaModalityIcon({ mediaType }: { mediaType: ChatMediaType }): JSX.Element {
  switch (mediaType) {
    case "video":
      return <Film size={12} className="shrink-0 text-ink-muted" />;
    case "image":
      return <ImageIcon size={12} className="shrink-0 text-ink-muted" />;
    case "narration":
      return <AudioLines size={12} className="shrink-0 text-ink-muted" />;
    case "music":
      return <Music size={12} className="shrink-0 text-ink-muted" />;
    case "sfx":
      return <Volume2 size={12} className="shrink-0 text-ink-muted" />;
    case "analysis":
      return <ScanSearch size={12} className="shrink-0 text-ink-muted" />;
  }
}

const PILL_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-[var(--surface-inset)] px-1.5 py-0.5 align-baseline text-xs text-foreground transition-colors hover:bg-[var(--surface-subtle)]";

export interface ChatMarkdownNarrationState {
  active: boolean;
  chunks: readonly AlignedChunk[];
  words: readonly AlignedWord[];
  sourceMap?: TranscriptSourceMap;
  audioLoaded: boolean;
  loadedDurationMs: number;
  activeCharStart: number | null;
  activeCharEnd: number | null;
  highlightColor?: HighlightColorId;
  onSeekWord?: (startMs: number) => void;
}

interface ChatWordRenderContext {
  markdown: string;
  alignedByMdOffset: Map<number, AlignedWord>;
  audioLoaded: boolean;
  loadedDurationMs: number;
  isNarrationMode: boolean;
  mdSpokenThrough: number;
  insideLink?: boolean;
  activeCharStart: number | null;
  activeCharEnd: number | null;
  highlightPalette: { bg: string; text: string };
  onSeekWord?: (startMs: number) => void;
}

interface RenderCallbacks {
  onSeek: (seconds: number) => void;
  onOpenRoute: (href: string) => void;
  wordCtx: ChatWordRenderContext | null;
}

function renderChatTextRunWithWords(
  sliceText: string,
  sliceMdStart: number,
  wordCtx: ChatWordRenderContext,
  keyPrefix: string,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\S+|\s+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(sliceText)) !== null) {
    const rawSegment = match[0];
    const segStart = sliceMdStart + match.index;

    if (/^\s+$/.test(rawSegment)) {
      parts.push(<span key={`${keyPrefix}_ws_${segStart}`}>{rawSegment}</span>);
      continue;
    }

    const normalized = normalizeSpeakableToken(rawSegment);
    const alignedWord = normalized
      ? wordCtx.alignedByMdOffset.get(segStart)
      : undefined;

    const isActive = Boolean(
      alignedWord &&
        wordCtx.activeCharStart !== null &&
        wordCtx.activeCharEnd !== null &&
        alignedWord.charStart < wordCtx.activeCharEnd &&
        alignedWord.charEnd > wordCtx.activeCharStart,
    );

    const canSeek = Boolean(
      wordCtx.audioLoaded &&
        alignedWord !== undefined &&
        alignedWord.startMs <= wordCtx.loadedDurationMs &&
        !wordCtx.insideLink,
    );

    const isSpoken =
      canSeek ||
      (wordCtx.mdSpokenThrough >= 0 && segStart <= wordCtx.mdSpokenThrough);

    if (!canSeek) {
      parts.push(
        <span
          key={`${keyPrefix}_plain_${segStart}`}
          aria-disabled={wordCtx.isNarrationMode ? "true" : undefined}
          data-word-selectable="false"
          data-word-active={isActive ? "true" : undefined}
          data-spoken={
            wordCtx.isNarrationMode ? (isSpoken ? "true" : "false") : undefined
          }
          style={
            isActive
              ? {
                  backgroundColor: wordCtx.highlightPalette.bg,
                  color: wordCtx.highlightPalette.text,
                }
              : undefined
          }
          className={cn(
            wordCtx.isNarrationMode
              ? "cursor-default select-none transition-colors duration-300"
              : undefined,
            isActive
              ? "reader-word-active"
              : wordCtx.isNarrationMode
                ? isSpoken
                  ? "text-foreground"
                  : "text-ink-faint"
                : undefined,
          )}
        >
          {rawSegment}
        </span>,
      );
      continue;
    }

    parts.push(
      <span
        key={`${keyPrefix}_w_${segStart}`}
        role="button"
        tabIndex={0}
        data-word-selectable="true"
        data-word-active={isActive ? "true" : undefined}
        data-spoken="true"
        data-start-ms={alignedWord!.startMs}
        onClick={() => wordCtx.onSeekWord?.(alignedWord!.startMs)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            wordCtx.onSeekWord?.(alignedWord!.startMs);
          }
        }}
        style={
          isActive
            ? {
                backgroundColor: wordCtx.highlightPalette.bg,
                color: wordCtx.highlightPalette.text,
              }
            : undefined
        }
        className={cn(
          "cursor-pointer rounded-[3px] transition-colors",
          isActive
            ? "reader-word-active"
            : "text-foreground hover:bg-foreground/10 active:bg-foreground/20",
        )}
      >
        {rawSegment}
      </span>,
    );
  }

  return parts;
}

function renderPlainSegments(
  value: string,
  baseMdOffset: number,
  cb: RenderCallbacks,
  keyPrefix: string,
): ReactNode[] {
  let relCursor = 0;
  return tokenizeInlineChatSegments(value).map((seg, idx) => {
    const key = `${keyPrefix}_seg_${idx}`;
    const segStart = baseMdOffset + relCursor;
    const segLen =
      seg.kind === "text"
        ? seg.text.length
        : seg.kind === "timestamp"
          ? seg.label.length
          : seg.raw.length;
    relCursor += segLen;

    if (seg.kind === "text") {
      if (cb.wordCtx) {
        return (
          <Fragment key={key}>
            {renderChatTextRunWithWords(seg.text, segStart, cb.wordCtx, key)}
          </Fragment>
        );
      }
      return <Fragment key={key}>{seg.text}</Fragment>;
    }
    if (seg.kind === "timestamp") {
      return (
        <button
          key={key}
          type="button"
          data-seek-seconds={seg.seconds}
          onClick={() => cb.onSeek(seg.seconds)}
          className={cn(PILL_CLASS, "font-mono text-[11.5px]")}
        >
          <Clock size={11} className="shrink-0 text-ink-muted" />
          <span>{seg.label}</span>
        </button>
      );
    }
    if (seg.kind === "media") {
      return (
        <ChatReferenceChip
          key={key}
          rawUri={seg.raw}
          reference={{
            uri: seg.raw,
            kind: seg.mediaType,
            id: seg.itemId,
            ...(seg.generationId ? { subId: seg.generationId } : {}),
            title: seg.label,
            href: seg.href,
          }}
          compact
          onOpenRoute={cb.onOpenRoute}
        />
      );
    }
    if (seg.kind === "entity") {
      return (
        <ChatReferenceChip
          key={key}
          rawUri={seg.raw}
          reference={{
            uri: seg.raw,
            kind: seg.entityKind,
            id: seg.id,
            ...(seg.subId ? { subId: seg.subId } : {}),
            title: seg.label,
            ...(seg.entityKind === "character" && seg.subId
              ? { metaLabel: `${seg.id}@${seg.subId}` }
              : {}),
            href: seg.href,
          }}
          compact={seg.entityKind !== "character"}
          onOpenRoute={cb.onOpenRoute}
        />
      );
    }
    return (
      <button
        key={key}
        type="button"
        data-route-href={seg.href}
        onClick={() => cb.onOpenRoute(seg.href)}
        className={cn(PILL_CLASS, "font-mono text-[11.5px]")}
      >
        <FileText size={11} className="shrink-0 text-ink-muted" />
        <span className="max-w-[200px] truncate">{seg.label}</span>
      </button>
    );
  });
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  cursorRef: { pos: number },
  blockEnd: number,
  cb: RenderCallbacks,
  keyPrefix: string,
): ReactNode[] {
  return (tokens ?? []).map((token, idx) => {
    const id = `${keyPrefix}_${idx}`;
    const sourceMd = cb.wordCtx?.markdown ?? "";
    const foundIdx =
      cb.wordCtx && token.raw && cursorRef.pos < blockEnd
        ? sourceMd.indexOf(token.raw, cursorRef.pos)
        : -1;
    const tokenStart =
      foundIdx !== -1 && foundIdx < blockEnd ? foundIdx : cursorRef.pos;
    const tokenEnd = Math.min(blockEnd, tokenStart + (token.raw?.length ?? 0));

    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          cursorRef.pos = tokenStart;
          const inner = renderInlineTokens(t.tokens, cursorRef, tokenEnd, cb, id);
          cursorRef.pos = tokenEnd;
          return <Fragment key={id}>{inner}</Fragment>;
        }
        const plainSource = cb.wordCtx ? t.raw : t.text;
        const inner = renderPlainSegments(plainSource, tokenStart, cb, id);
        cursorRef.pos = tokenEnd;
        return <Fragment key={id}>{inner}</Fragment>;
      }
      case "escape": {
        const escText = (token as Tokens.Escape).text;
        const innerStart = Math.min(blockEnd, tokenStart + 1);
        cursorRef.pos = tokenEnd;
        if (cb.wordCtx) {
          return (
            <Fragment key={id}>
              {renderChatTextRunWithWords(escText, innerStart, cb.wordCtx, id)}
            </Fragment>
          );
        }
        return <Fragment key={id}>{escText}</Fragment>;
      }
      case "strong": {
        const s = token as Tokens.Strong;
        const markerMatch = s.raw.match(/^([*_]+)/);
        const markerLen = markerMatch ? markerMatch[1]!.length : 2;
        cursorRef.pos = Math.min(blockEnd, tokenStart + markerLen);
        const inner = renderInlineTokens(s.tokens, cursorRef, tokenEnd, cb, id);
        cursorRef.pos = tokenEnd;
        return (
          <strong
            key={id}
            className={cn("font-semibold", !cb.wordCtx && "text-foreground")}
          >
            {inner}
          </strong>
        );
      }
      case "em": {
        const e = token as Tokens.Em;
        cursorRef.pos = Math.min(blockEnd, tokenStart + 1);
        const inner = renderInlineTokens(e.tokens, cursorRef, tokenEnd, cb, id);
        cursorRef.pos = tokenEnd;
        return (
          <em key={id} className="italic">
            {inner}
          </em>
        );
      }
      case "del": {
        const d = token as Tokens.Del;
        cursorRef.pos = Math.min(blockEnd, tokenStart + 2);
        const inner = renderInlineTokens(d.tokens, cursorRef, tokenEnd, cb, id);
        cursorRef.pos = tokenEnd;
        return (
          <del key={id} className="text-ink-muted line-through">
            {inner}
          </del>
        );
      }
      case "codespan": {
        const codeToken = token as Tokens.Codespan;
        const codeText = codeToken.text;
        const parsedMedia = parseChatMediaLink(codeText);
        if (parsedMedia) {
          cursorRef.pos = tokenEnd;
          return (
            <ChatReferenceChip
              key={id}
              rawUri={codeText.trim()}
              reference={{
                uri: codeText.trim(),
                kind: parsedMedia.mediaType,
                id: parsedMedia.itemId,
                ...(parsedMedia.generationId ? { subId: parsedMedia.generationId } : {}),
                title: defaultMediaPillLabel(parsedMedia.mediaType, parsedMedia.itemId),
                href: parsedMedia.href,
              }}
              compact
              onOpenRoute={cb.onOpenRoute}
            />
          );
        }
        const parsedEntity = parseChatEntityUri(codeText);
        if (parsedEntity) {
          cursorRef.pos = tokenEnd;
          return (
            <ChatReferenceChip
              key={id}
              rawUri={codeText.trim()}
              reference={{
                uri: parsedEntity.uri,
                kind: parsedEntity.kind,
                id: parsedEntity.id,
                ...(parsedEntity.subId ? { subId: parsedEntity.subId } : {}),
                title: defaultEntityPillLabel(parsedEntity),
                href: parsedEntity.href,
              }}
              compact={parsedEntity.kind !== "character"}
              onOpenRoute={cb.onOpenRoute}
            />
          );
        }
        const innerRel = codeToken.raw.indexOf(codeText);
        const innerStart = tokenStart + (innerRel !== -1 ? innerRel : 1);
        cursorRef.pos = tokenEnd;
        return (
          <code
            key={id}
            className={cn(
              "rounded bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[0.86em]",
              !cb.wordCtx && "text-foreground",
            )}
          >
            {cb.wordCtx
              ? renderChatTextRunWithWords(codeText, innerStart, cb.wordCtx, id)
              : codeText}
          </code>
        );
      }
      case "br":
        cursorRef.pos = tokenEnd;
        return <br key={id} />;
      case "link": {
        const link = token as Tokens.Link;
        const parsedMedia = parseChatMediaLink(link.href);
        if (parsedMedia) {
          cursorRef.pos = tokenEnd;
          const customLabel = link.text?.trim();
          const pillLabel =
            customLabel && !customLabel.toLowerCase().startsWith("mdmedia://")
              ? customLabel
              : defaultMediaPillLabel(parsedMedia.mediaType, parsedMedia.itemId);
          return (
            <ChatReferenceChip
              key={id}
              rawUri={link.href.trim()}
              reference={{
                uri: link.href.trim(),
                kind: parsedMedia.mediaType,
                id: parsedMedia.itemId,
                ...(parsedMedia.generationId ? { subId: parsedMedia.generationId } : {}),
                title: pillLabel,
                href: parsedMedia.href,
              }}
              onOpenRoute={cb.onOpenRoute}
            />
          );
        }
        const parsedEntity = parseChatEntityUri(link.href);
        if (parsedEntity) {
          cursorRef.pos = tokenEnd;
          const customLabel = link.text?.trim();
          const pillLabel =
            customLabel && !customLabel.toLowerCase().startsWith("mdmedia://")
              ? customLabel
              : defaultEntityPillLabel(parsedEntity);
          return (
            <ChatReferenceChip
              key={id}
              rawUri={link.href.trim()}
              reference={{
                uri: parsedEntity.uri,
                kind: parsedEntity.kind,
                id: parsedEntity.id,
                ...(parsedEntity.subId ? { subId: parsedEntity.subId } : {}),
                title: pillLabel,
                ...(parsedEntity.kind === "character" && parsedEntity.subId
                  ? { metaLabel: `${parsedEntity.id}@${parsedEntity.subId}` }
                  : {}),
                href: parsedEntity.href,
              }}
              onOpenRoute={cb.onOpenRoute}
            />
          );
        }
        if (isInternalStudioRoute(link.href)) {
          cursorRef.pos = tokenEnd;
          const href = link.href.trim();
          const label = link.text?.trim() || href;
          return (
            <button
              key={id}
              type="button"
              data-route-href={href}
              onClick={() => cb.onOpenRoute(href)}
              className={PILL_CLASS}
            >
              <FileText size={11} className="shrink-0 text-ink-muted" />
              <span className="max-w-[200px] truncate">{label}</span>
            </button>
          );
        }
        const linkCb: RenderCallbacks = cb.wordCtx
          ? { ...cb, wordCtx: { ...cb.wordCtx, insideLink: true } }
          : cb;
        cursorRef.pos = Math.min(blockEnd, tokenStart + 1);
        const children = renderInlineTokens(link.tokens, cursorRef, tokenEnd, linkCb, id);
        cursorRef.pos = tokenEnd;
        if (isExternalSafeHref(link.href)) {
          return (
            <a
              key={id}
              href={link.href.trim()}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
            >
              {children}
            </a>
          );
        }
        return <Fragment key={id}>{children}</Fragment>;
      }
      case "image": {
        const img = token as Tokens.Image;
        cursorRef.pos = tokenEnd;
        const parsedMedia = parseChatMediaLink(img.href);
        if (parsedMedia) {
          const label =
            img.text?.trim() ||
            defaultMediaPillLabel(parsedMedia.mediaType, parsedMedia.itemId);
          return (
            <button
              key={id}
              type="button"
              data-media-uri={img.href.trim()}
              data-route-href={parsedMedia.href}
              onClick={() => cb.onOpenRoute(parsedMedia.href)}
              className={PILL_CLASS}
            >
              <MediaModalityIcon mediaType={parsedMedia.mediaType} />
              <span className="max-w-[200px] truncate">{label}</span>
            </button>
          );
        }
        return <Fragment key={id}>{img.text || img.raw}</Fragment>;
      }
      default:
        cursorRef.pos = tokenEnd;
        // Raw HTML and unknown inline tokens stay plain escaped text, never DOM nodes.
        return (
          <Fragment key={id}>
            {"text" in token && typeof token.text === "string" ? token.text : token.raw}
          </Fragment>
        );
    }
  });
}

function renderBlockTokens(
  tokens: Token[],
  baseMdOffset: number,
  blockEndLimit: number,
  cb: RenderCallbacks,
  keyPrefix: string,
): ReactNode[] {
  let rawCursor = baseMdOffset;
  const sourceMd = cb.wordCtx?.markdown ?? "";

  return tokens.map((token, idx) => {
    const id = `${keyPrefix}_${idx}`;
    const found =
      cb.wordCtx && token.raw && rawCursor < blockEndLimit
        ? sourceMd.indexOf(token.raw, rawCursor)
        : -1;
    const mdStart =
      found !== -1 && found < blockEndLimit ? found : rawCursor;
    const mdEnd = Math.min(blockEndLimit, mdStart + (token.raw?.length ?? 0));
    rawCursor = mdEnd;

    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        const h = token as Tokens.Heading;
        const depth = Math.min(6, Math.max(1, h.depth));
        const Tag = `h${depth}` as "h1";
        const prefixMatch = h.raw.match(/^\s{0,3}#{1,6}[ \t]+/);
        const contentStart = mdStart + (prefixMatch ? prefixMatch[0].length : 0);
        const cursorRef = { pos: contentStart };
        const isHeadingSpoken =
          cb.wordCtx !== null &&
          cb.wordCtx.mdSpokenThrough >= 0 &&
          contentStart <= cb.wordCtx.mdSpokenThrough;
        return (
          <Tag
            key={id}
            data-chat-block-edge=""
            data-spoken={
              cb.wordCtx?.isNarrationMode
                ? isHeadingSpoken
                  ? "true"
                  : "false"
                : undefined
            }
            className={cn(
              "min-w-0",
              HEADING_CLASSES[depth],
              cb.wordCtx?.isNarrationMode
                ? isHeadingSpoken
                  ? depth <= 4
                    ? "text-foreground"
                    : undefined
                  : "text-ink-faint"
                : depth <= 4
                  ? "text-foreground"
                  : undefined,
            )}
          >
            {renderInlineTokens(h.tokens, cursorRef, mdEnd, cb, id)}
          </Tag>
        );
      }
      case "paragraph": {
        const cursorRef = { pos: mdStart };
        const isParagraphSpoken =
          cb.wordCtx !== null &&
          cb.wordCtx.mdSpokenThrough >= 0 &&
          mdStart <= cb.wordCtx.mdSpokenThrough;
        return (
          <p
            key={id}
            data-chat-block-edge=""
            data-spoken={
              cb.wordCtx?.isNarrationMode
                ? isParagraphSpoken
                  ? "true"
                  : "false"
                : undefined
            }
            className={cn(
              "min-w-0",
              cb.wordCtx?.isNarrationMode && !isParagraphSpoken
                ? "text-ink-faint"
                : undefined,
            )}
          >
            {renderInlineTokens(
              (token as Tokens.Paragraph).tokens,
              cursorRef,
              mdEnd,
              cb,
              id,
            )}
          </p>
        );
      }
      case "text": {
        const t = token as Tokens.Text;
        const cursorRef = { pos: mdStart };
        return (
          <p key={id} data-chat-block-edge="" className="min-w-0">
            {t.tokens
              ? renderInlineTokens(t.tokens, cursorRef, mdEnd, cb, id)
              : renderPlainSegments(
                  cb.wordCtx ? t.raw : t.text,
                  mdStart,
                  cb,
                  id,
                )}
          </p>
        );
      }
      case "list": {
        const list = token as Tokens.List;
        const Tag = list.ordered ? "ol" : "ul";
        const start = typeof list.start === "number" ? list.start : 1;
        let itemRelCursor = 0;
        return (
          <Tag key={id} className="grid w-full min-w-0 list-none gap-1.5">
            {list.items.map((item, i) => {
              const itemRel = list.raw.indexOf(item.raw, itemRelCursor);
              const itemStart =
                mdStart + (itemRel !== -1 ? itemRel : itemRelCursor);
              const itemEnd = itemStart + item.raw.length;
              itemRelCursor =
                (itemRel !== -1 ? itemRel : itemRelCursor) + item.raw.length;
              const itemPrefix = item.raw.match(
                /^[ \t]*(?:[*+-]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/,
              );
              const contentStart =
                itemStart + (itemPrefix ? itemPrefix[0].length : 0);
              const isItemSpoken =
                cb.wordCtx !== null &&
                cb.wordCtx.mdSpokenThrough >= 0 &&
                contentStart <= cb.wordCtx.mdSpokenThrough;

              return (
                <li
                  key={`${id}_${i}`}
                  data-spoken={
                    cb.wordCtx?.isNarrationMode
                      ? isItemSpoken
                        ? "true"
                        : "false"
                      : undefined
                  }
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "select-none font-mono text-xs",
                      cb.wordCtx?.isNarrationMode && !isItemSpoken
                        ? "text-ink-faint"
                        : "text-ink-muted",
                    )}
                  >
                    {item.task
                      ? item.checked
                        ? "☑"
                        : "☐"
                      : list.ordered
                        ? `${start + i}.`
                        : "•"}
                  </span>
                  <div className="grid min-w-0 gap-1">
                    {renderBlockTokens(
                      item.tokens,
                      contentStart,
                      itemEnd,
                      cb,
                      `${id}_${i}`,
                    )}
                  </div>
                </li>
              );
            })}
          </Tag>
        );
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const prefixMatch = quote.raw.match(/^[ \t]*>[ \t]?/);
        const contentStart = mdStart + (prefixMatch ? prefixMatch[0].length : 0);
        const isQuoteSpoken =
          cb.wordCtx !== null &&
          cb.wordCtx.mdSpokenThrough >= 0 &&
          contentStart <= cb.wordCtx.mdSpokenThrough;
        return (
          <blockquote
            key={id}
            data-spoken={
              cb.wordCtx?.isNarrationMode
                ? isQuoteSpoken
                  ? "true"
                  : "false"
                : undefined
            }
            className={cn(
              "grid grid-cols-[2px_minmax(0,1fr)] gap-2.5 italic",
              cb.wordCtx?.isNarrationMode && !isQuoteSpoken
                ? "text-ink-faint"
                : "text-ink-muted",
            )}
          >
            <span aria-hidden="true" className="rounded-full bg-border" />
            <div className="grid min-w-0 gap-2">
              {renderBlockTokens(quote.tokens, contentStart, mdEnd, cb, id)}
            </div>
          </blockquote>
        );
      }
      case "code": {
        const code = token as Tokens.Code;
        return (
          <div
            key={id}
            data-chat-block-edge=""
            className="grid min-w-0 overflow-x-auto"
          >
            <CodeBlock code={code.text} lang={code.lang} />
          </div>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const cellCursor = { pos: mdStart };
        return (
          <div
            key={id}
            data-chat-block-edge=""
            className="grid w-full overflow-x-auto rounded-lg border border-border"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-border bg-[var(--surface-inset)]">
                <tr>
                  {table.header.map((cell, c) => (
                    <th key={c} className="p-2 font-semibold">
                      {renderInlineTokens(
                        cell.tokens,
                        cellCursor,
                        mdEnd,
                        cb,
                        `${id}_h${c}`,
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r} className="border-b border-border last:border-b-0">
                    {row.map((cell, c) => (
                      <td key={c} className="p-2">
                        {renderInlineTokens(
                          cell.tokens,
                          cellCursor,
                          mdEnd,
                          cb,
                          `${id}_${r}_${c}`,
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "hr":
        return (
          <hr
            key={id}
            data-chat-block-edge=""
            className="border-t border-border"
          />
        );
      default:
        // Raw HTML blocks (`<script>`, `<iframe>`, etc.) are rendered strictly as escaped text.
        return (
          <p
            key={id}
            data-chat-block-edge=""
            className="min-w-0 whitespace-pre-wrap text-ink-muted"
          >
            {token.raw}
          </p>
        );
    }
  });
}

export interface ChatMarkdownProps {
  markdown: string;
  onSeekTimestamp?: ((seconds: number) => void) | null;
  onOpenRoute?: ((href: string) => void) | null;
  narration?: ChatMarkdownNarrationState | null;
  className?: string;
}

export function ChatMarkdown({
  markdown,
  onSeekTimestamp,
  onOpenRoute,
  narration,
  className,
}: ChatMarkdownProps): JSX.Element | null {
  const tokens = useMemo(() => {
    if (!markdown.trim()) return null;
    try {
      return lexer(markdown, { gfm: true });
    } catch {
      return null;
    }
  }, [markdown]);

  const narrationEnabled = Boolean(
    narration && (narration.active || narration.words.length > 0),
  );

  const alignment = useMemo(() => {
    if (!narrationEnabled || !narration) return null;
    return alignMarkdownWords(
      markdown,
      narration.words as AlignedWord[],
      narration.sourceMap,
      narration.chunks as AlignedChunk[],
    );
  }, [
    markdown,
    narrationEnabled,
    narration?.words,
    narration?.sourceMap,
    narration?.chunks,
  ]);

  const highlightPalette = useMemo(
    () => getChatHighlightPalette(narration?.highlightColor),
    [narration?.highlightColor],
  );

  const effectiveAudioLoaded = Boolean(
    narration && (narration.audioLoaded || narration.words.length > 0),
  );
  const effectiveLoadedDurationMs = narration?.loadedDurationMs ?? 0;

  const mdSpokenThrough = useMemo(() => {
    if (!alignment || !effectiveAudioLoaded) return -1;
    let maxMd = -1;
    for (const [mdOffset, alignedWord] of alignment.alignedByMdOffset.entries()) {
      if (alignedWord.startMs <= effectiveLoadedDurationMs) {
        const wordLen = Math.max(1, alignedWord.charEnd - alignedWord.charStart);
        maxMd = Math.max(maxMd, mdOffset + wordLen);
      }
    }
    return maxMd;
  }, [alignment, effectiveAudioLoaded, effectiveLoadedDurationMs]);

  if (!markdown.trim()) return null;

  const wordCtx: ChatWordRenderContext | null =
    narrationEnabled && narration && alignment
      ? {
          markdown,
          alignedByMdOffset: alignment.alignedByMdOffset,
          audioLoaded: effectiveAudioLoaded,
          loadedDurationMs: effectiveLoadedDurationMs,
          isNarrationMode: narration.active || effectiveAudioLoaded,
          mdSpokenThrough,
          activeCharStart: narration.activeCharStart,
          activeCharEnd: narration.activeCharEnd,
          highlightPalette,
          onSeekWord: narration.onSeekWord,
        }
      : null;

  const callbacks: RenderCallbacks = {
    onSeek: (seconds) => {
      if (onSeekTimestamp) {
        onSeekTimestamp(seconds);
      } else {
        seekActiveChatSurface(seconds, true);
      }
    },
    onOpenRoute: (href) => {
      if (onOpenRoute) {
        onOpenRoute(href);
      } else if (typeof window !== "undefined") {
        window.location.assign(href);
      }
    },
    wordCtx,
  };

  const highlightStyle = wordCtx
    ? ({
        "--reader-highlight-bg": highlightPalette.bg,
        "--reader-highlight-fg": highlightPalette.text,
      } as CSSProperties)
    : undefined;

  return (
    <div
      style={highlightStyle}
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 text-[13.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {tokens ? (
        renderBlockTokens(tokens, 0, markdown.length, callbacks, "chatmd")
      ) : wordCtx ? (
        <p data-chat-block-edge="" className="min-w-0 whitespace-pre-wrap">
          {renderChatTextRunWithWords(markdown, 0, wordCtx, "chatmd_raw")}
        </p>
      ) : (
        <p data-chat-block-edge="" className="min-w-0 whitespace-pre-wrap">
          {markdown}
        </p>
      )}
    </div>
  );
}
