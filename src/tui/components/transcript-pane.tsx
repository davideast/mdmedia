import type { TrackMetadata, ChunkTiming } from '../../storage/types.js';
import type { SessionItem, TurnItem } from '../../studio/session-catalog.js';
import type { NavigationDepth } from '../../studio/types.js';
import {
  buildHighlightedMarkdownBlocks,
  resolveTranscriptSource,
} from '../../studio/highlight-renderer.js';
import { parseMarkdownToSpeakableParagraphs } from '../../chunker/index.js';

export interface TranscriptPaneProps {
  navDepth?: NavigationDepth;
  selectedSession?: SessionItem | null;
  track: TrackMetadata | null;
  turn?: TurnItem | null;
  viewMode?: 'markdown' | 'script';
  positionMs?: number;
  activeChunkIndex: number;
  liveStreaming: boolean;
  currentLiveChunkText: string | null;
  focused: boolean;
  selectedIndex?: number;
  scrollOffset?: number;
}

export function computeTranscriptWindowStartIdx(
  targetIdx: number,
  windowSize: number,
  total: number,
  padding: number = 3
): number {
  if (total <= 0 || windowSize <= 0) return 0;
  let start = 0;
  if (targetIdx >= windowSize - padding) {
    start = targetIdx - (windowSize - padding - 1);
  }
  if (start + windowSize > total) {
    start = Math.max(0, total - windowSize);
  }
  return Math.max(0, start);
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
  navDepth = 'turns',
  selectedSession = null,
  track,
  turn = null,
  viewMode = 'markdown',
  positionMs = 0,
  activeChunkIndex,
  liveStreaming,
  currentLiveChunkText,
  focused,
  selectedIndex = 0,
  scrollOffset = 0,
}: TranscriptPaneProps) {
  const borderColor = focused ? '#38bdf8' : '#334155';
  // Text and timings MUST come from the same source — see resolveTranscriptSource.
  const { text: markdownText, chunkTimings } = resolveTranscriptSource(turn, track);
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

  const effectiveSelectedIndex =
    totalScrollItems > 0
      ? Math.max(
          0,
          Math.min(
            totalScrollItems - 1,
            focused
              ? selectedIndex
              : (viewMode === 'markdown'
                  ? (activeBlockIdx >= 0 ? activeBlockIdx : selectedIndex)
                  : (activeChunkIndex >= 0 ? activeChunkIndex : selectedIndex))
          )
        )
      : 0;

  const totalTerminalRows = process.stdout.rows || 40;
  const availableContentRows = Math.max(8, totalTerminalRows - (liveStreaming ? 15 : 10));

  if (navDepth === 'sessions') {
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
        title={selectedSession ? `Conversation: ${selectedSession.shortId} [2]` : 'Conversation [2]'}
        titleColor={focused ? '#38bdf8' : '#94a3b8'}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
      >
        {!selectedSession ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg="#64748b">No conversation selected.</text>
            <text fg="#475569">Use [j/k] to browse conversations.</text>
          </box>
        ) : (
          <box flexDirection="column" flexGrow={1} width="100%">
            {/* Header: Status and Title */}
            <box flexDirection="column" marginBottom={1}>
              <box flexDirection="row" gap={1}>
                <text fg={selectedSession.isActive ? '#10b981' : '#64748b'}>
                  <b>{selectedSession.isActive ? '● ACTIVE (Open Antigravity CLI session)' : '○ INACTIVE (Closed session)'}</b>
                </text>
              </box>
              <text fg="#38bdf8" wrapMode="none">
                <b>{selectedSession.title}</b>
              </text>
              <text fg="#64748b" wrapMode="none">
                Session ID: {selectedSession.id}
              </text>
            </box>

            {/* Quick Metrics Bar */}
            <box
              flexDirection="row"
              justifyContent="space-between"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor="#1e293b"
              height={1}
              marginBottom={1}
            >
              <text fg="#94a3b8">
                Responses: <span fg="#38bdf8"><b>{selectedSession.turnCount}</b></span>
              </text>
              <text fg="#94a3b8">
                Folded steps: <span fg="#e2e8f0">{selectedSession.foldedStepCount}</span>
              </text>
              <text fg="#94a3b8">
                Audio: <span fg={selectedSession.hasAudio ? '#10b981' : '#64748b'}>
                  {selectedSession.hasAudio ? '🔊 Cached' : 'None yet'}
                </span>
              </text>
            </box>

            {/* Initial Prompt Preview */}
            {selectedSession.previewPrompt ? (
              <box flexDirection="column" marginBottom={1}>
                <text fg="#94a3b8"><b>Initial User Prompt:</b></text>
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  borderStyle="single"
                  borderColor="#334155"
                >
                  <text fg="#cbd5e1" wrapMode="word">
                    {selectedSession.previewPrompt}
                  </text>
                </box>
              </box>
            ) : null}

            {/* Latest Response Preview */}
            {selectedSession.previewResponse ? (
              <box flexDirection="column" flexGrow={1} overflow="hidden" marginBottom={1}>
                <text fg="#94a3b8"><b>Latest Substantive Response:</b></text>
                <box
                  flexGrow={1}
                  paddingLeft={1}
                  paddingRight={1}
                  borderStyle="single"
                  borderColor="#334155"
                  overflow="hidden"
                >
                  <text fg="#94a3b8" wrapMode="word">
                    {selectedSession.previewResponse}
                  </text>
                </box>
              </box>
            ) : null}

            {/* Action Prompt */}
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor="#0f172a"
              borderStyle="single"
              borderColor="#38bdf8"
              height={3}
              justifyContent="center"
            >
              <text fg="#38bdf8">
                <b>▸ Press [Enter] or [l] to drill into this conversation's responses.</b>
              </text>
              <text fg="#64748b">
                Browse substantive turns, generate audio narration, and inspect transcripts.
              </text>
            </box>
          </box>
        )}
      </box>
    );
  }

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
                ? ` • Block ${effectiveSelectedIndex + 1}/${totalScrollItems}`
                : ''}
              {focused ? ' • [j/k] navigate • [Enter] seek' : ' • [Tab] focus'}
            </text>
          </box>

          {viewMode === 'markdown' ? (
            (() => {
              const startIdx = computeTranscriptWindowStartIdx(
                effectiveSelectedIndex,
                availableContentRows,
                blocks.length
              );
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
                    const blockIdx = startIdx + idx;
                    const isSelected = focused && blockIdx === effectiveSelectedIndex;
                    const isSpokenBlock = block.isActive;

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
                          key={blockIdx}
                          flexDirection="column"
                          width="100%"
                          backgroundColor={isSelected ? '#1e293b' : '#0f172a'}
                          borderStyle={isSelected ? 'single' : undefined}
                          borderColor={isSelected ? '#38bdf8' : undefined}
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
                        key={blockIdx}
                        width="100%"
                        flexDirection="row"
                        backgroundColor={
                          isSelected
                            ? isSpokenBlock
                              ? '#2563eb'
                              : '#1e3a8a'
                            : isSpokenBlock
                              ? '#0f2b5c'
                              : undefined
                        }
                        paddingLeft={1}
                        paddingRight={1}
                        marginBottom={1}
                        gap={1}
                      >
                        <text fg={isSelected ? '#38bdf8' : '#64748b'}>
                          {isSelected ? '▸ ' : '  '}
                        </text>
                        {block.timestampBadge && (
                          <text fg={isSelected || isSpokenBlock ? '#38bdf8' : '#64748b'}>
                            {block.timestampBadge}
                          </text>
                        )}
                        {isSpokenBlock ? (
                          <text fg="#ffffff" wrapMode="word">
                            {renderRichMarkdownSegment(
                              block.beforeWord,
                              `b-${blockIdx}`
                            )}
                            <span fg="#facc15">
                              <b>{cleanActiveWordToken(block.activeWord)}</b>
                            </span>
                            {renderRichMarkdownSegment(
                              block.afterWord,
                              `a-${blockIdx}`
                            )}
                          </text>
                        ) : (
                          <text fg={isSelected ? '#ffffff' : '#cbd5e1'} wrapMode="word">
                            {renderRichMarkdownSegment(
                              block.text,
                              `p-${blockIdx}`
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
              const startIdx = computeTranscriptWindowStartIdx(
                effectiveSelectedIndex,
                availableContentRows,
                chunkTimings.length
              );
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
                  {visibleChunks.map((chunk: ChunkTiming, idx: number) => {
                    const chunkItemIdx = startIdx + idx;
                    const isSelected = focused && chunkItemIdx === effectiveSelectedIndex;
                    const isActive = chunk.chunkIndex === activeChunkIndex;
                    const startStr = formatTime(chunk.startMs);
                    const endStr = formatTime(chunk.endMs);

                    return (
                      <box
                        key={chunk.chunkIndex}
                        width="100%"
                        flexDirection="row"
                        backgroundColor={
                          isSelected
                            ? isActive
                              ? '#2563eb'
                              : '#1e3a8a'
                            : isActive
                              ? '#0f2b5c'
                              : undefined
                        }
                        paddingLeft={1}
                        paddingRight={1}
                        gap={1}
                      >
                        <text fg={isSelected ? '#38bdf8' : '#64748b'}>
                          {isSelected ? '▸ ' : '  '}
                        </text>
                        <text fg={isSelected || isActive ? '#38bdf8' : '#64748b'}>
                          [{startStr} - {endStr}]{isActive ? ' 🔊' : ''}
                        </text>
                        <text
                          fg={isSelected ? '#ffffff' : isActive ? '#93c5fd' : '#cbd5e1'}
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
              const startIdx = computeTranscriptWindowStartIdx(
                effectiveSelectedIndex,
                availableContentRows,
                scriptParagraphs.length
              );
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
                  {visibleParagraphs.map((para, idx) => {
                    const paraIndex = startIdx + idx;
                    const isSelected = focused && paraIndex === effectiveSelectedIndex;

                    return (
                      <box
                        key={paraIndex}
                        width="100%"
                        flexDirection="row"
                        backgroundColor={isSelected ? '#1e3a8a' : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                        gap={1}
                      >
                        <text fg={isSelected ? '#38bdf8' : '#64748b'}>
                          {isSelected ? '▸ ' : '  '}[{String(paraIndex + 1).padStart(2, '0')}]
                        </text>
                        <text fg={isSelected ? '#ffffff' : '#cbd5e1'} wrapMode="word">
                          {para}
                        </text>
                      </box>
                    );
                  })}
                </box>
              );
            })()
          )}
        </box>
      )}
    </box>
  );
}

