"use client";

import { cn } from "cn";
import { lexer, type Token, type Tokens } from "marked";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { CodeBlock } from "./code-block";
import { DocumentMediaCard } from "./document-media-card";
import {
  alignMarkdownWords,
  normalizeSpeakableToken,
  parseMediaUri,
} from "../../lib/markdown-word-aligner";
import type {
  MediaRemixRequest,
  MediaRemixResult,
  TreeDocumentReaderProps,
  TreeMediaRef,
} from "../../lib/tree-types";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  type AlignedWord,
  type HighlightColorId,
} from "../../lib/types";

export function getHighlightPalette(colorId?: HighlightColorId) {
  const effectiveId = colorId ?? DEFAULT_HIGHLIGHT_COLOR;
  return (
    HIGHLIGHT_COLORS.find((item) => item.id === effectiveId) ??
    HIGHLIGHT_COLORS[0]
  );
}

function isSafeHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("#")
  ) {
    return true;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(":")).toLowerCase();
    return (
      scheme === "https" ||
      scheme === "http" ||
      scheme === "mailto" ||
      scheme === "mdmedia"
    );
  }
  return !trimmed.startsWith("//");
}

function extractStandaloneMediaEmbed(
  tokens: Token[] | undefined,
  pathAssets: Record<string, TreeMediaRef>,
  docPath: string,
): { mediaRef: TreeMediaRef; alt: string } | null {
  if (!tokens || tokens.length !== 1) return null;
  const only = tokens[0]!;
  if (only.type === "image") {
    const imgToken = only as Tokens.Image;
    const ref = parseMediaUri(imgToken.href, pathAssets, docPath);
    if (ref) {
      return { mediaRef: ref, alt: imgToken.text || "" };
    }
  }
  if (only.type === "link") {
    const linkToken = only as Tokens.Link;
    if (linkToken.href.trim().toLowerCase().startsWith("mdmedia://")) {
      const ref = parseMediaUri(linkToken.href, pathAssets, docPath);
      if (ref) {
        return { mediaRef: ref, alt: linkToken.text || "" };
      }
    }
  }
  return null;
}

interface WordRenderContext {
  markdown: string;
  pathAssets: Record<string, TreeMediaRef>;
  treeId: string;
  docPath: string;
  alignedByMdOffset: Map<number, AlignedWord>;
  fallbackToPlain: boolean;
  hasWords: boolean;
  audioLoaded: boolean;
  loadedDurationMs: number;
  isNarrationMode: boolean;
  mdSpokenThrough: number;
  insideLink?: boolean;
  activeCharStart: number | null;
  activeCharEnd: number | null;
  spokenThrough: number;
  highlightPalette: { bg: string; text: string };
  onSeekWord?: (startMs: number) => void;
  onRemixMedia?: (request: MediaRemixRequest) => Promise<MediaRemixResult>;
  resolveDocHref?: (rawHref: string) => string | null;
  onNavigateDocHref?: (resolvedHref: string) => void;
}

function resolveRelativeDocPath(rawPath: string, currentDocPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/^\/+/, "");
  }
  const baseSegments = currentDocPath
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  // Pop current filename to get parent directory segments
  if (baseSegments.length > 0) {
    baseSegments.pop();
  }
  const relSegments = trimmed.split("/");
  const stack = trimmed.startsWith("./") || trimmed.startsWith("../") ? [...baseSegments] : [...baseSegments];
  for (const seg of relSegments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

function resolveInternalTreeHref(
  rawHref: string,
  ctx: WordRenderContext,
): { href: string; isInternalDoc: boolean } {
  const trimmed = rawHref.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)
  ) {
    return { href: rawHref, isInternalDoc: false };
  }

  if (ctx.resolveDocHref) {
    const resolved = ctx.resolveDocHref(trimmed);
    if (resolved) {
      return { href: resolved, isInternalDoc: true };
    }
  }

  if (trimmed.startsWith("/trees/")) {
    return { href: trimmed, isInternalDoc: true };
  }

  const hashIdx = trimmed.indexOf("#");
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
  const pathPart = (hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed).split("?")[0] ?? "";
  const resolvedPath = resolveRelativeDocPath(pathPart, ctx.docPath);
  if (ctx.treeId && resolvedPath) {
    const encodedSegments = resolvedPath
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join("/");
    return {
      href: `/trees/${encodeURIComponent(ctx.treeId)}/${encodedSegments}${hash}`,
      isInternalDoc: true,
    };
  }

  return { href: rawHref, isInternalDoc: false };
}

function renderTextRunWithWords(
  sliceText: string,
  sliceMdStart: number,
  ctx: WordRenderContext,
  keyPrefix: string,
): ReactNode[] {
  if (!ctx.isNarrationMode && ctx.alignedByMdOffset.size === 0) {
    return [sliceText];
  }

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
      ? ctx.alignedByMdOffset.get(segStart)
      : undefined;

    const isActive = Boolean(
      alignedWord &&
        ctx.activeCharStart !== null &&
        ctx.activeCharEnd !== null &&
        alignedWord.charStart < ctx.activeCharEnd &&
        alignedWord.charEnd > ctx.activeCharStart,
    );

    const canSeek = Boolean(
      ctx.audioLoaded &&
        alignedWord !== undefined &&
        alignedWord.startMs <= ctx.loadedDurationMs &&
        !ctx.insideLink,
    );

    const isSpoken =
      canSeek || (ctx.mdSpokenThrough >= 0 && segStart <= ctx.mdSpokenThrough);

    if (!canSeek) {
      parts.push(
        <span
          key={`${keyPrefix}_plain_${segStart}`}
          aria-disabled={ctx.isNarrationMode ? "true" : undefined}
          data-word-selectable="false"
          data-word-active={isActive ? "true" : undefined}
          data-spoken={
            ctx.isNarrationMode ? (isSpoken ? "true" : "false") : undefined
          }
          style={
            isActive
              ? {
                  backgroundColor: ctx.highlightPalette.bg,
                  color: ctx.highlightPalette.text,
                }
              : undefined
          }
          className={cn(
            ctx.isNarrationMode
              ? "cursor-default select-none transition-colors duration-300"
              : undefined,
            isActive
              ? "reader-word-active"
              : ctx.isNarrationMode
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
        onClick={() => ctx.onSeekWord?.(alignedWord!.startMs)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            ctx.onSeekWord?.(alignedWord!.startMs);
          }
        }}
        style={
          isActive
            ? {
                backgroundColor: ctx.highlightPalette.bg,
                color: ctx.highlightPalette.text,
              }
            : undefined
        }
        className={cn(
          "cursor-pointer rounded-[3px] px-[1px] -mx-[1px] transition-colors",
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

function renderInlineTokens(
  tokens: Token[] | undefined,
  cursorRef: { pos: number },
  blockEnd: number,
  ctx: WordRenderContext,
  keyPrefix: string,
): ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  const nodes: ReactNode[] = [];

  tokens.forEach((token, idx) => {
    const key = `${keyPrefix}_${idx}`;
    const foundIdx =
      token.raw && cursorRef.pos < blockEnd
        ? ctx.markdown.indexOf(token.raw, cursorRef.pos)
        : -1;
    const tokenStart =
      foundIdx !== -1 && foundIdx < blockEnd ? foundIdx : cursorRef.pos;
    const tokenEnd = Math.min(blockEnd, tokenStart + (token.raw?.length ?? 0));

    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          cursorRef.pos = tokenStart;
          nodes.push(
            <span key={key}>
              {renderInlineTokens(
                textToken.tokens,
                cursorRef,
                tokenEnd,
                ctx,
                key,
              )}
            </span>,
          );
          cursorRef.pos = tokenEnd;
        } else {
          nodes.push(
            ...renderTextRunWithWords(textToken.raw, tokenStart, ctx, key),
          );
          cursorRef.pos = tokenEnd;
        }
        break;
      }

      case "strong": {
        const strongToken = token as Tokens.Strong;
        const markerMatch = strongToken.raw.match(/^([*_]+)/);
        const markerLen = markerMatch ? markerMatch[1]!.length : 2;
        cursorRef.pos = Math.min(blockEnd, tokenStart + markerLen);
        nodes.push(
          <strong key={key} className="font-semibold">
            {renderInlineTokens(
              strongToken.tokens,
              cursorRef,
              tokenEnd,
              ctx,
              key,
            )}
          </strong>,
        );
        cursorRef.pos = tokenEnd;
        break;
      }

      case "em": {
        const emToken = token as Tokens.Em;
        cursorRef.pos = Math.min(blockEnd, tokenStart + 1);
        nodes.push(
          <em key={key} className="italic">
            {renderInlineTokens(emToken.tokens, cursorRef, tokenEnd, ctx, key)}
          </em>,
        );
        cursorRef.pos = tokenEnd;
        break;
      }

      case "del": {
        const delToken = token as Tokens.Del;
        cursorRef.pos = Math.min(blockEnd, tokenStart + 2);
        nodes.push(
          <del key={key} className="line-through text-ink-muted">
            {renderInlineTokens(delToken.tokens, cursorRef, tokenEnd, ctx, key)}
          </del>,
        );
        cursorRef.pos = tokenEnd;
        break;
      }

      case "codespan": {
        const codeToken = token as Tokens.Codespan;
        const innerRel = codeToken.raw.indexOf(codeToken.text);
        const innerStart = tokenStart + (innerRel !== -1 ? innerRel : 1);
        const trimmedCode = codeToken.text.trim();
        const linkedDocHref =
          ctx.resolveDocHref && /\.md(?:#.*)?$/i.test(trimmedCode)
            ? ctx.resolveDocHref(trimmedCode)
            : null;
        const codeCtx = linkedDocHref ? { ...ctx, insideLink: true } : ctx;
        const codeEl = (
          <code
            key={key}
            className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[0.88em]"
          >
            {renderTextRunWithWords(codeToken.text, innerStart, codeCtx, key)}
          </code>
        );
        if (linkedDocHref) {
          nodes.push(
            <a
              key={key}
              href={linkedDocHref}
              onClick={
                ctx.onNavigateDocHref
                  ? (event) => {
                      if (
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey &&
                        event.button === 0
                      ) {
                        event.preventDefault();
                        ctx.onNavigateDocHref?.(linkedDocHref);
                      }
                    }
                  : undefined
              }
              className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
            >
              {codeEl}
            </a>,
          );
        } else {
          nodes.push(codeEl);
        }
        cursorRef.pos = tokenEnd;
        break;
      }

      case "link": {
        const linkToken = token as Tokens.Link;
        const mediaRef = linkToken.href
          .trim()
          .toLowerCase()
          .startsWith("mdmedia://")
          ? parseMediaUri(linkToken.href, ctx.pathAssets, ctx.docPath)
          : null;

        if (mediaRef) {
          cursorRef.pos = tokenEnd;
          nodes.push(
            <DocumentMediaCard
              key={key}
              mediaRef={mediaRef}
              alt={linkToken.text}
              onRemixMedia={ctx.onRemixMedia}
            />,
          );
          break;
        }

        const labelText = linkToken.text ?? "";
        const isRawUrlLabel = /^https?:\/\//i.test(labelText.trim());
        const linkCtx = { ...ctx, insideLink: true };
        cursorRef.pos = Math.min(blockEnd, tokenStart + 1);
        const children = isRawUrlLabel
          ? [labelText]
          : linkToken.tokens && linkToken.tokens.length > 0
            ? renderInlineTokens(
                linkToken.tokens,
                cursorRef,
                tokenEnd,
                linkCtx,
                key,
              )
            : renderTextRunWithWords(labelText, cursorRef.pos, linkCtx, key);
        cursorRef.pos = tokenEnd;

        if (!isSafeHref(linkToken.href)) {
          nodes.push(
            <span key={key} data-unsafe-link="true" className="text-ink-muted">
              {children}
            </span>,
          );
          break;
        }

        const isExternal = /^https?:\/\//i.test(linkToken.href.trim());
        const { href: resolvedHref, isInternalDoc } = isExternal
          ? { href: linkToken.href, isInternalDoc: false }
          : resolveInternalTreeHref(linkToken.href, ctx);

        nodes.push(
          <a
            key={key}
            href={resolvedHref}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noopener noreferrer" : undefined}
            onClick={
              isInternalDoc && ctx.onNavigateDocHref
                ? (event) => {
                    if (
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey &&
                      event.button === 0
                    ) {
                      event.preventDefault();
                      ctx.onNavigateDocHref?.(resolvedHref);
                    }
                  }
                : undefined
            }
            className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
          >
            {children}
          </a>,
        );
        break;
      }

      case "image": {
        const imgToken = token as Tokens.Image;
        cursorRef.pos = tokenEnd;
        const mediaRef = parseMediaUri(
          imgToken.href,
          ctx.pathAssets,
          ctx.docPath,
        );
        if (mediaRef) {
          nodes.push(
            <DocumentMediaCard
              key={key}
              mediaRef={mediaRef}
              alt={imgToken.text}
              onRemixMedia={ctx.onRemixMedia}
            />,
          );
        } else if (isSafeHref(imgToken.href)) {
          nodes.push(
            <a
              key={key}
              href={imgToken.href}
              target="_blank"
              rel="noopener noreferrer"
              data-external-image="true"
              className="underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
            >
              {imgToken.text || imgToken.href}
            </a>,
          );
        } else {
          nodes.push(
            <span key={key} data-unsafe-image="true" className="text-ink-muted">
              {imgToken.text}
            </span>,
          );
        }
        break;
      }

      case "br": {
        cursorRef.pos = tokenEnd;
        nodes.push(<br key={key} />);
        break;
      }

      case "html": {
        const htmlToken = token as Tokens.HTML | Tokens.Tag;
        cursorRef.pos = tokenEnd;
        nodes.push(
          <span key={key} className="font-mono text-xs text-ink-muted">
            {htmlToken.raw}
          </span>,
        );
        break;
      }

      default: {
        if (
          "tokens" in token &&
          Array.isArray((token as { tokens?: Token[] }).tokens)
        ) {
          cursorRef.pos = tokenStart;
          nodes.push(
            <span key={key}>
              {renderInlineTokens(
                (token as { tokens: Token[] }).tokens,
                cursorRef,
                tokenEnd,
                ctx,
                key,
              )}
            </span>,
          );
          cursorRef.pos = tokenEnd;
        } else if (
          "text" in token &&
          typeof (token as { text?: unknown }).text === "string"
        ) {
          nodes.push(
            ...renderTextRunWithWords(
              (token as { text: string }).text,
              tokenStart,
              ctx,
              key,
            ),
          );
          cursorRef.pos = tokenEnd;
        } else {
          cursorRef.pos = tokenEnd;
        }
        break;
      }
    }
  });

  return nodes;
}

const HEADING_CLASSES: Record<number, string> = {
  1: "t-h1",
  2: "t-h2",
  3: "font-display text-[1.125rem] font-semibold leading-snug",
  4: "font-display text-[1rem] font-semibold leading-snug",
  5: "font-display text-[0.9375rem] font-semibold leading-snug text-ink-muted",
  6: "font-display text-[0.875rem] font-semibold uppercase tracking-wider text-ink-muted",
};

function renderBlockquoteTokens(
  tokens: Token[],
  cursorRef: { pos: number },
  blockEnd: number,
  ctx: WordRenderContext,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];

  tokens.forEach((token, idx) => {
    const key = `${keyPrefix}_q_${idx}`;
    if (token.type === "paragraph") {
      const pToken = token as Tokens.Paragraph;
      nodes.push(
        <p key={key} className="min-w-0">
          {renderInlineTokens(pToken.tokens, cursorRef, blockEnd, ctx, key)}
        </p>,
      );
    } else if (
      "tokens" in token &&
      Array.isArray((token as { tokens?: Token[] }).tokens)
    ) {
      nodes.push(
        <div key={key} className="min-w-0">
          {renderInlineTokens(
            (token as { tokens: Token[] }).tokens,
            cursorRef,
            blockEnd,
            ctx,
            key,
          )}
        </div>,
      );
    } else if (
      "text" in token &&
      typeof (token as { text?: unknown }).text === "string"
    ) {
      nodes.push(
        <p key={key} className="min-w-0">
          {renderTextRunWithWords(
            (token as { text: string }).text,
            cursorRef.pos,
            ctx,
            key,
          )}
        </p>,
      );
    }
  });

  return nodes;
}

function renderListToken(
  listToken: Tokens.List,
  listMdStart: number,
  ctx: WordRenderContext,
  keyPrefix: string,
): ReactNode {
  const ListTag = listToken.ordered ? "ol" : "ul";
  const startNum = typeof listToken.start === "number" ? listToken.start : 1;
  let itemCursor = 0;

  return (
    <ListTag key={keyPrefix} className="grid w-full min-w-0 list-none gap-2">
      {listToken.items.map((item, idx) => {
        const itemRelIdx = listToken.raw.indexOf(item.raw, itemCursor);
        const itemStart =
          listMdStart + (itemRelIdx !== -1 ? itemRelIdx : itemCursor);
        const itemEnd = itemStart + item.raw.length;
        itemCursor =
          (itemRelIdx !== -1 ? itemRelIdx : itemCursor) + item.raw.length;

        const itemPrefix = item.raw.match(
          /^[ \t]*(?:[*+-]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/,
        );
        const contentStart =
          itemStart + (itemPrefix ? itemPrefix[0].length : 0);
        const cursorRef = { pos: contentStart };
        const itemKey = `${keyPrefix}_li_${idx}`;
        const markerLabel = listToken.ordered ? `${startNum + idx}.` : "•";

        const isItemSpoken =
          ctx.mdSpokenThrough >= 0 && contentStart <= ctx.mdSpokenThrough;

        return (
          <li
            key={itemKey}
            data-spoken={
              ctx.isNarrationMode
                ? isItemSpoken
                  ? "true"
                  : "false"
                : undefined
            }
            className="reader-block grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2.5 min-w-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "font-mono text-xs select-none",
                ctx.isNarrationMode && !isItemSpoken
                  ? "text-ink-faint"
                  : "text-ink-muted",
              )}
            >
              {markerLabel}
            </span>
            <div className="grid min-w-0 gap-1.5">
              {item.tokens.map((subToken, subIdx) => {
                const subKey = `${itemKey}_${subIdx}`;
                if (subToken.type === "list") {
                  const subList = subToken as Tokens.List;
                  const subRel = ctx.markdown.indexOf(
                    subList.raw,
                    cursorRef.pos,
                  );
                  const subStart =
                    subRel !== -1 && subRel < itemEnd
                      ? subRel
                      : cursorRef.pos;
                  cursorRef.pos = Math.min(
                    itemEnd,
                    subStart + subList.raw.length,
                  );
                  return renderListToken(subList, subStart, ctx, subKey);
                }
                if (
                  "tokens" in subToken &&
                  Array.isArray((subToken as { tokens?: Token[] }).tokens)
                ) {
                  return (
                    <span key={subKey} className="min-w-0">
                      {renderInlineTokens(
                        (subToken as { tokens: Token[] }).tokens,
                        cursorRef,
                        itemEnd,
                        ctx,
                        subKey,
                      )}
                    </span>
                  );
                }
                return (
                  <span key={subKey} className="min-w-0">
                    {renderTextRunWithWords(
                      (subToken as { text?: string }).text ?? subToken.raw,
                      cursorRef.pos,
                      ctx,
                      subKey,
                    )}
                  </span>
                );
              })}
            </div>
          </li>
        );
      })}
    </ListTag>
  );
}

function computePositionedTopTokens(markdown: string) {
  const tokens = lexer(markdown);
  const out: Array<{
    token: Token;
    mdStart: number;
    mdEnd: number;
    blockKey: string;
  }> = [];
  let cursor = 0;
  for (let blockIdx = 0; blockIdx < tokens.length; blockIdx += 1) {
    const token = tokens[blockIdx]!;
    const rawIdx = markdown.indexOf(token.raw, cursor);
    const mdStart = rawIdx !== -1 ? rawIdx : cursor;
    const mdEnd = mdStart + token.raw.length;
    cursor = mdEnd;
    out.push({
      token,
      mdStart,
      mdEnd,
      blockKey: `blk_${blockIdx}_${mdStart}`,
    });
  }
  return out;
}

export function TreeDocumentReader({
  document,
  pathAssets,
  words = [],
  chunks,
  sourceMap,
  activeCharStart,
  activeCharEnd,
  spokenThrough,
  audioLoaded,
  loadedDurationMs,
  narrationActive = false,
  highlightColor,
  onSeekWord,
  onRemixMedia,
  resolveDocHref,
  onNavigateDocHref,
  className,
}: TreeDocumentReaderProps) {
  const markdown = document.markdown ?? "";
  const alignment = useMemo(
    () => alignMarkdownWords(markdown, words, sourceMap, chunks),
    [markdown, words, sourceMap, chunks],
  );
  const positionedTopTokens = useMemo(
    () => computePositionedTopTokens(markdown),
    [markdown],
  );
  const highlightPalette = useMemo(
    () => getHighlightPalette(highlightColor),
    [highlightColor],
  );

  const effectiveAudioLoaded = audioLoaded ?? words.length > 0;
  const effectiveLoadedDurationMs = useMemo(() => {
    if (loadedDurationMs !== undefined) return loadedDurationMs;
    return words.reduce((end, word) => Math.max(end, word.endMs), 0);
  }, [loadedDurationMs, words]);

  const isNarrationMode =
    narrationActive || effectiveAudioLoaded || spokenThrough > 0;

  const mdSpokenThrough = useMemo(() => {
    if (!effectiveAudioLoaded) return -1;
    let maxMd = -1;
    for (const [mdOffset, alignedWord] of alignment.alignedByMdOffset.entries()) {
      if (alignedWord.startMs <= effectiveLoadedDurationMs) {
        const wordLen = Math.max(1, alignedWord.charEnd - alignedWord.charStart);
        maxMd = Math.max(maxMd, mdOffset + wordLen);
      }
    }
    return maxMd;
  }, [
    alignment.alignedByMdOffset,
    effectiveAudioLoaded,
    effectiveLoadedDurationMs,
  ]);

  const highlightVars = {
    "--reader-highlight-bg": highlightPalette.bg,
    "--reader-highlight-fg": highlightPalette.text,
  } as CSSProperties;

  const ctx: WordRenderContext = {
    markdown,
    pathAssets,
    treeId: document.treeId,
    docPath: document.path,
    alignedByMdOffset: alignment.alignedByMdOffset,
    fallbackToPlain: alignment.fallbackToPlain,
    hasWords: words.length > 0,
    audioLoaded: effectiveAudioLoaded,
    loadedDurationMs: effectiveLoadedDurationMs,
    isNarrationMode,
    mdSpokenThrough,
    activeCharStart,
    activeCharEnd,
    spokenThrough,
    highlightPalette,
    onSeekWord,
    onRemixMedia,
    resolveDocHref,
    onNavigateDocHref,
  };

  return (
    <article
      style={highlightVars}
      data-tree-document-id={document.id}
      data-tree-node-id={document.nodeId}
      data-alignment-fallback={alignment.fallbackToPlain ? "plain" : "aligned"}
      className={cn(
        "grid w-full min-w-0 max-w-[68ch] justify-self-center gap-5 text-[1.0625rem] leading-[1.68] text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {positionedTopTokens.map(({ token, mdStart, mdEnd, blockKey }) => {
        switch (token.type) {
          case "space":
            return null;

          case "heading": {
            const hToken = token as Tokens.Heading;
            const depth = Math.min(6, Math.max(1, hToken.depth)) as
              | 1
              | 2
              | 3
              | 4
              | 5
              | 6;
            const HeadingTag = `h${depth}` as const;
            const prefixMatch = hToken.raw.match(/^\s{0,3}#{1,6}[ \t]+/);
            const contentStart =
              mdStart + (prefixMatch ? prefixMatch[0].length : 0);
            const cursorRef = { pos: contentStart };

            const isHeadingSpoken =
              mdSpokenThrough >= 0 && contentStart <= mdSpokenThrough;

            return (
              <HeadingTag
                key={blockKey}
                data-spoken={
                  isNarrationMode
                    ? isHeadingSpoken
                      ? "true"
                      : "false"
                    : undefined
                }
                className={cn(
                  "reader-block min-w-0",
                  HEADING_CLASSES[depth],
                  isNarrationMode && !isHeadingSpoken
                    ? "text-ink-faint"
                    : undefined,
                )}
              >
                {renderInlineTokens(
                  hToken.tokens,
                  cursorRef,
                  mdEnd,
                  ctx,
                  blockKey,
                )}
              </HeadingTag>
            );
          }

          case "paragraph": {
            const pToken = token as Tokens.Paragraph;
            const standaloneMedia = extractStandaloneMediaEmbed(
              pToken.tokens,
              pathAssets,
              document.path,
            );
            if (standaloneMedia) {
              return (
                <DocumentMediaCard
                  key={blockKey}
                  mediaRef={standaloneMedia.mediaRef}
                  alt={standaloneMedia.alt}
                  onRemixMedia={onRemixMedia}
                />
              );
            }

            const isParagraphSpoken =
              mdSpokenThrough >= 0 && mdStart <= mdSpokenThrough;
            const cursorRef = { pos: mdStart };
            return (
              <p
                key={blockKey}
                data-spoken={
                  isNarrationMode
                    ? isParagraphSpoken
                      ? "true"
                      : "false"
                    : undefined
                }
                className={cn(
                  "reader-block min-w-0",
                  isNarrationMode && !isParagraphSpoken
                    ? "text-ink-faint"
                    : undefined,
                )}
              >
                {renderInlineTokens(
                  pToken.tokens,
                  cursorRef,
                  mdEnd,
                  ctx,
                  blockKey,
                )}
              </p>
            );
          }

          case "list": {
            return renderListToken(
              token as Tokens.List,
              mdStart,
              ctx,
              blockKey,
            );
          }

          case "blockquote": {
            const quoteToken = token as Tokens.Blockquote;
            const prefixMatch = quoteToken.raw.match(/^[ \t]*>[ \t]?/);
            const contentStart =
              mdStart + (prefixMatch ? prefixMatch[0].length : 0);
            const isQuoteSpoken =
              mdSpokenThrough >= 0 && contentStart <= mdSpokenThrough;
            const cursorRef = { pos: contentStart };

            return (
              <blockquote
                key={blockKey}
                data-spoken={
                  isNarrationMode
                    ? isQuoteSpoken
                      ? "true"
                      : "false"
                    : undefined
                }
                className={cn(
                  "reader-block grid grid-cols-[2px_minmax(0,1fr)] gap-3 italic",
                  isNarrationMode && !isQuoteSpoken
                    ? "text-ink-faint"
                    : "text-ink-muted",
                )}
              >
                <span aria-hidden="true" className="rounded-full bg-border" />
                <div className="grid min-w-0 gap-3">
                  {renderBlockquoteTokens(
                    quoteToken.tokens,
                    cursorRef,
                    mdEnd,
                    ctx,
                    blockKey,
                  )}
                </div>
              </blockquote>
            );
          }

          case "code": {
            const codeToken = token as Tokens.Code;
            const lang = codeToken.lang?.trim().toLowerCase();
            if (lang === "mermaid") {
              return (
                <DocumentMediaCard
                  key={blockKey}
                  mediaRef={{ type: "mermaid", id: codeToken.text.trim() }}
                  alt="Mermaid diagram"
                  onRemixMedia={onRemixMedia}
                />
              );
            }
            return (
              <CodeBlock
                key={blockKey}
                code={codeToken.text}
                lang={codeToken.lang}
                className="w-full"
              />
            );
          }

          case "table": {
            const tableToken = token as Tokens.Table;
            const isTableSpoken =
              mdSpokenThrough >= 0 && mdStart <= mdSpokenThrough;
            const cursorRef = { pos: mdStart };
            return (
              <div
                key={blockKey}
                data-spoken={
                  isNarrationMode
                    ? isTableSpoken
                      ? "true"
                      : "false"
                    : undefined
                }
                className={cn(
                  "reader-block grid w-full overflow-x-auto rounded-lg border border-border",
                  isNarrationMode && !isTableSpoken
                    ? "text-ink-faint"
                    : undefined,
                )}
              >
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="border-b border-border bg-surface-inset">
                    <tr>
                      {tableToken.header.map((cell, hIdx) => (
                        <th
                          key={`${blockKey}_th_${hIdx}`}
                          className="p-2.5 font-semibold"
                        >
                          {renderInlineTokens(
                            cell.tokens,
                            cursorRef,
                            mdEnd,
                            ctx,
                            `${blockKey}_th_${hIdx}`,
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableToken.rows.map((row, rIdx) => (
                      <tr
                        key={`${blockKey}_tr_${rIdx}`}
                        className="border-b border-border last:border-b-0"
                      >
                        {row.map((cell, cIdx) => (
                          <td
                            key={`${blockKey}_td_${rIdx}_${cIdx}`}
                            className="p-2.5"
                          >
                            {renderInlineTokens(
                              cell.tokens,
                              cursorRef,
                              mdEnd,
                              ctx,
                              `${blockKey}_td_${rIdx}_${cIdx}`,
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
            return <hr key={blockKey} className="border-t border-border" />;

          case "html": {
            const htmlToken = token as Tokens.HTML;
            return (
              <pre
                key={blockKey}
                className="grid w-full overflow-x-auto rounded-md border border-border bg-surface-inset p-3 font-mono text-xs text-ink-muted"
              >
                {htmlToken.raw}
              </pre>
            );
          }

          default:
            return null;
        }
      })}
    </article>
  );
}
