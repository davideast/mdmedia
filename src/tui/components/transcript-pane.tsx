import type { TrackMetadata } from '../../storage/types.js';
import type { TurnItem } from '../../studio/session-catalog.js';
import { buildHighlightedMarkdownBlocks } from '../../studio/highlight-renderer.js';
import { parseMarkdownToSpeakableParagraphs } from '../../chunker/index.js';

export interface TranscriptPaneProps {
  track: TrackMetadata | null;
  turn?: TurnItem | null;
  viewMode?: 'markdown' | 'script';
  positionMs?: number;
  activeChunkIndex: number;
  liveStreaming: boolean;
  currentLiveChunkText: string | null;
  focused: boolean;
  scrollOffset?: number;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function cleanActiveWordToken(token: string): string {
  const linkMatch = token.match(/^\[([^\]]+)\]\([^)]+\)$/);
  if (linkMatch) {
    return linkMatch[1].replace(/`/g, '');
  }
  if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
    return token.slice(1, -1);
  }
  if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
    return token.slice(2, -2);
  }
  return token;
}

function renderPlainOrHeadingText(text: string, keyPrefix: string) {
  const headingMatch = text.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return (
      <span key={keyPrefix} fg="#38bdf8">
        <b>{headingMatch[2]}</b>
      </span>
    );
  }
  return <span key={keyPrefix}>{text}</span>;
}

function renderRichMarkdownSegment(segment: string, keyPrefix: string) {
  if (!segment) return null;
  const parts: any[] = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)|`([^`\n]+)`|\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(segment)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        renderPlainOrHeadingText(
          segment.slice(lastIndex, match.index),
          `${keyPrefix}-txt-${idx++}`
        )
      );
    }

    if (match[1] !== undefined) {
      // Markdown link [label](url) -> styled underlined label without raw URL
      const cleanLabel = match[1].replace(/`/g, '');
      parts.push(
        <span key={`${keyPrefix}-lnk-${idx++}`} fg="#38bdf8">
          <u>{cleanLabel}</u>
        </span>
      );
    } else if (match[3] !== undefined) {
      // Inline code tick `code` -> visual code pill without backticks
      parts.push(
        <span key={`${keyPrefix}-code-${idx++}`} fg="#67e8f9" bg="#1e293b">
          {match[3]}
        </span>
      );
    } else if (match[4] !== undefined) {
      // Bold **text** -> bold without asterisks
      parts.push(<b key={`${keyPrefix}-bold-${idx++}`}>{match[4]}</b>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < segment.length) {
    parts.push(
      renderPlainOrHeadingText(segment.slice(lastIndex), `${keyPrefix}-end`)
    );
  }

  return parts;
}

function renderSyntaxHighlightedCodeLine(line: string, lineIdx: number) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
    return (
      <text key={lineIdx} wrapMode="none">
        <span fg="#475569">│ </span>
        <span fg="#64748b">{line}</span>
      </text>
    );
  }

  const keywordRegex =
    /\b(export|import|from|function|const|let|var|return|if|else|interface|type|async|await|public|private|class|func|true|false|null|undefined|void|string|number|boolean)\b/g;
  const parts: any[] = [<span key="bar" fg="#475569">│ </span>];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let kIdx = 0;

  while ((match = keywordRegex.exec(line)) !== null) {
    if (match.index > lastIdx) {
      parts.push(
        <span key={`c-${kIdx++}`} fg="#e2e8f0">
          {line.slice(lastIdx, match.index)}
        </span>
      );
    }
    parts.push(
      <span key={`kw-${kIdx++}`} fg="#c084fc">
        <b>{match[0]}</b>
      </span>
    );
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < line.length) {
    parts.push(
      <span key="end" fg="#e2e8f0">
        {line.slice(lastIdx)}
      </span>
    );
  }

  return (
    <text key={lineIdx} wrapMode="none">
      {parts}
    </text>
  );
}

export function TranscriptPane({
  track,
  turn = null,
  viewMode = 'markdown',
  positionMs = 0,
  activeChunkIndex,
  liveStreaming,
  currentLiveChunkText,
  focused,
  scrollOffset = 0,
}: TranscriptPaneProps) {
  const borderColor = focused ? '#38bdf8' : '#334155';
  const markdownText = turn?.markdown ?? track?.transcript ?? '';
  const chunkTimings =
    track?.chunkTimings && track.chunkTimings.length > 0
      ? track.chunkTimings
      : turn?.track?.chunkTimings ?? [];
  const rawBlocks = buildHighlightedMarkdownBlocks(markdownText, chunkTimings, positionMs);
  const blocks = rawBlocks.flatMap((block) => {
    if (block.type !== 'code') return [block];
    const rawLines = block.text.split('\n');
    const codeLines = rawLines.filter(
      (l, i) => !((i === 0 || i === rawLines.length - 1) && l.trim().startsWith('```'))
    );
    if (codeLines.length <= 12) return [block];
    const chunks: typeof rawBlocks = [];
    for (let i = 0; i < codeLines.length; i += 12) {
      chunks.push({
        ...block,
        text: codeLines.slice(i, i + 12).join('\n'),
      });
    }
    return chunks;
  });
  const scriptParagraphs =
    chunkTimings.length === 0 ? parseMarkdownToSpeakableParagraphs(markdownText) : [];

  const displayTitle = turn?.title ?? track?.title ?? 'Untitled';
  const activeBlockIdx = blocks.findIndex((b) => b.isActive);
  const totalScrollItems =
    viewMode === 'markdown'
      ? blocks.length
      : chunkTimings.length > 0
        ? chunkTimings.length
        : scriptParagraphs.length;
  const activeScrollItemIdx =
    viewMode === 'markdown' ? activeBlockIdx : activeChunkIndex;
  const currentBlockDisplayIdx =
    totalScrollItems > 0
      ? Math.min(
          totalScrollItems,
          (focused
            ? scrollOffset
            : activeScrollItemIdx >= 0
              ? activeScrollItemIdx
              : scrollOffset) + 1
        )
      : 0;

  return (
    <box
      flexDirection="column"
      width="64%"
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
      height="100%"
      borderStyle="single"
      borderColor={borderColor}
      title={`Transcript [${viewMode}] [v]`}
      titleColor={focused ? '#38bdf8' : '#94a3b8'}
      paddingLeft={1}
      paddingRight={1}
    >
      {liveStreaming && currentLiveChunkText && (
        <box
          height={3}
          marginBottom={1}
          borderStyle="single"
          borderColor="#10b981"
          backgroundColor="#064e3b"
          paddingLeft={1}
          paddingRight={1}
          justifyContent="center"
        >
          <text fg="#6ee7b7">
            <b>● Live Generating: </b>
            {currentLiveChunkText}
          </text>
        </box>
      )}

      {!track && !turn ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg="#64748b">No turn or track selected.</text>
          <text fg="#475569">
            Select a turn from the library [j/k] or send /listen in Antigravity.
          </text>
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1} width="100%" height="100%">
          {/* Metadata bar */}
          <box
            height={1}
            marginBottom={1}
            flexDirection="row"
            justifyContent="space-between"
            width="100%"
          >
            <text fg="#94a3b8">
              <b>{displayTitle}</b>
            </text>
            <text fg="#64748b">
              [y] Copy • [v] View: {viewMode === 'markdown' ? 'Markdown' : 'Script'} •{' '}
              {turn ? `${turn.wordCount} words` : `${track?.charCount ?? 0} chars`}
              {totalScrollItems > 0
                ? ` • Block ${currentBlockDisplayIdx}/${totalScrollItems}`
                : ''}
              {focused ? ' • [j/k] scroll' : ' • [Tab] scroll'}
            </text>
          </box>

          {viewMode === 'markdown' ? (
            (() => {
              const startIdx = focused
                ? Math.max(0, Math.min(blocks.length - 1, scrollOffset))
                : activeBlockIdx >= 0
                  ? Math.max(0, activeBlockIdx - 1)
                  : Math.max(0, Math.min(blocks.length - 1, scrollOffset));
              const visibleBlocks = blocks.slice(startIdx);

              return (
                <box
                  flexDirection="column"
                  flexGrow={1}
                  width="100%"
                  height="100%"
                  overflow="hidden"
                  gap={1}
                >
                  {visibleBlocks.map((block, idx) => {
                    if (block.type === 'code') {
                      const rawLines = block.text.split('\n');
                      const codeLines = rawLines.filter(
                        (l, i) =>
                          !(
                            (i === 0 || i === rawLines.length - 1) &&
                            l.trim().startsWith('```')
                          )
                      );

                      return (
                        <box
                          key={startIdx + idx}
                          flexDirection="column"
                          width="100%"
                          backgroundColor="#0f172a"
                          paddingLeft={1}
                          paddingRight={1}
                          marginBottom={1}
                        >
                          {codeLines.map((line, lineIdx) =>
                            renderSyntaxHighlightedCodeLine(line, lineIdx)
                          )}
                        </box>
                      );
                    }

                    return (
                      <box
                        key={startIdx + idx}
                        width="100%"
                        flexDirection="row"
                        backgroundColor={block.isActive ? '#1e3a8a' : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                        marginBottom={1}
                        gap={1}
                      >
                        {block.timestampBadge && (
                          <text fg={block.isActive ? '#38bdf8' : '#64748b'}>
                            {block.timestampBadge}
                          </text>
                        )}
                        {block.isActive ? (
                          <text fg="#ffffff" wrapMode="word">
                            {renderRichMarkdownSegment(
                              block.beforeWord,
                              `b-${startIdx + idx}`
                            )}
                            <span fg="#facc15">
                              <b>{cleanActiveWordToken(block.activeWord)}</b>
                            </span>
                            {renderRichMarkdownSegment(
                              block.afterWord,
                              `a-${startIdx + idx}`
                            )}
                          </text>
                        ) : (
                          <text fg="#cbd5e1" wrapMode="word">
                            {renderRichMarkdownSegment(
                              block.text,
                              `p-${startIdx + idx}`
                            )}
                          </text>
                        )}
                      </box>
                    );
                  })}
                </box>
              );
            })()
          ) : chunkTimings.length > 0 ? (
            (() => {
              const startIdx = focused
                ? Math.max(0, Math.min(chunkTimings.length - 1, scrollOffset))
                : activeChunkIndex >= 0
                  ? Math.max(0, activeChunkIndex - 1)
                  : Math.max(0, Math.min(chunkTimings.length - 1, scrollOffset));
              const visibleChunks = chunkTimings.slice(startIdx);

              return (
                <box
                  flexDirection="column"
                  flexGrow={1}
                  width="100%"
                  height="100%"
                  overflow="hidden"
                  gap={1}
                >
                  {visibleChunks.map((chunk) => {
                    const isActive = chunk.chunkIndex === activeChunkIndex;
                    const startStr = formatTime(chunk.startMs);
                    const endStr = formatTime(chunk.endMs);

                    return (
                      <box
                        key={chunk.chunkIndex}
                        width="100%"
                        flexDirection="row"
                        backgroundColor={isActive ? '#1e3a8a' : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                        gap={1}
                      >
                        <text fg={isActive ? '#38bdf8' : '#64748b'}>
                          [{startStr} - {endStr}]
                        </text>
                        <text
                          fg={isActive ? '#ffffff' : '#cbd5e1'}
                          wrapMode="word"
                        >
                          {chunk.text}
                        </text>
                      </box>
                    );
                  })}
                </box>
              );
            })()
          ) : (
            (() => {
              const startIdx = focused
                ? Math.max(0, Math.min(scriptParagraphs.length - 1, scrollOffset))
                : Math.max(0, Math.min(scriptParagraphs.length - 1, scrollOffset));
              const visibleParagraphs = scriptParagraphs.slice(startIdx);

              return (
                <box
                  flexDirection="column"
                  flexGrow={1}
                  width="100%"
                  height="100%"
                  overflow="hidden"
                  gap={1}
                >
                  {visibleParagraphs.map((para, idx) => (
                    <box
                      key={startIdx + idx}
                      width="100%"
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      gap={1}
                    >
                      <text fg="#64748b">
                        [{String(startIdx + idx + 1).padStart(2, '0')}]
                      </text>
                      <text fg="#cbd5e1" wrapMode="word">
                        {para}
                      </text>
                    </box>
                  ))}
                </box>
              );
            })()
          )}
        </box>
      )}
    </box>
  );
}

