import type { TrackMetadata } from '../../storage/types.js';
import type { SessionItem, TurnItem } from '../../studio/session-catalog.js';
import type { NavigationDepth } from '../../studio/types.js';

export interface LibraryPaneProps {
  navDepth?: NavigationDepth;
  sessions?: SessionItem[];
  selectedSession?: SessionItem | null;
  tracks: TrackMetadata[];
  selectedTrack: TrackMetadata | null;
  turns?: TurnItem[];
  selectedTurn?: TurnItem | null;
  audioOnlyFilter?: boolean;
  playingTrackId: string | null;
  filterQuery: string;
  focused: boolean;
  filterActive?: boolean;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function timeAgo(mtimeMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getStatusBadge(
  status: TurnItem['status'],
  isPlaying: boolean
): { symbol: string; color: string } {
  if (isPlaying) {
    return { symbol: '▶', color: '#38bdf8' };
  }
  if (status === 'cached') {
    return { symbol: '●', color: '#10b981' };
  }
  if (status === 'synthesizing') {
    return { symbol: '~', color: '#f59e0b' };
  }
  return { symbol: '·', color: '#475569' };
}

export function LibraryPane({
  navDepth = 'sessions',
  sessions = [],
  selectedSession = null,
  tracks,
  selectedTrack,
  turns = [],
  selectedTurn = null,
  audioOnlyFilter = false,
  playingTrackId,
  filterQuery,
  focused,
  filterActive = false,
}: LibraryPaneProps) {
  const borderColor = focused ? '#38bdf8' : '#334155';
  const activeSessionCount = sessions.filter((s) => s.isActive).length;

  const paneTitle =
    navDepth === 'sessions'
      ? `Conversations (${sessions.length} total • ${activeSessionCount} open in CLI) [1]`
      : `Responses: ${selectedSession?.shortId ?? 'Selected'} [1]`;

  return (
    <box
      flexDirection="column"
      width="36%"
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
      height="100%"
      borderStyle="single"
      borderColor={borderColor}
      title={paneTitle}
      titleColor={focused ? '#38bdf8' : '#94a3b8'}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      {/* Search / Filter Indicator */}
      <box height={1} marginBottom={1} flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" gap={1}>
          <text fg={filterActive ? '#f59e0b' : '#64748b'}>
            {filterActive ? '[Search]' : '[/]'}
          </text>
          <text fg={filterQuery ? '#38bdf8' : '#475569'}>
            {filterQuery || (filterActive ? 'Type query...' : 'Press / to search')}
          </text>
        </box>
        <text fg={audioOnlyFilter ? '#38bdf8' : '#64748b'}>
          [f] Audio Only: {audioOnlyFilter ? 'ON' : 'OFF'}
        </text>
      </box>

      {/* Breadcrumb row when drilled down into Turns */}
      {navDepth === 'turns' && (
        <box height={1} marginBottom={1} flexDirection="row" justifyContent="space-between" width="100%">
          <text wrapMode="none">
            <span fg="#38bdf8">← [Esc] </span>
            <span fg="#e2e8f0">{selectedSession?.shortId ?? 'Session'}</span>
            <span fg={selectedSession?.isActive ? '#10b981' : '#64748b'}>
              {' '}({selectedSession?.isActive ? 'CLI OPEN' : 'INACTIVE'})
            </span>
          </text>
          <text fg="#475569">[Enter] narrate</text>
        </box>
      )}

      {/* LEVEL 1: Sessions List */}
      {navDepth === 'sessions' ? (
        sessions.length === 0 ? (
          <box marginTop={2} justifyContent="center" alignItems="center">
            <text fg="#64748b">No conversations found.</text>
            <text fg="#475569">Start an Antigravity CLI session in your terminal</text>
          </box>
        ) : (
          (() => {
            const selectedIndex = Math.max(
              0,
              sessions.findIndex((s) => s.id === selectedSession?.id)
            );
            const totalTerminalRows = process.stdout.rows || 48;
            const availablePanelRows = Math.max(18, totalTerminalRows - 11);
            const WINDOW_SIZE = Math.max(6, Math.floor(availablePanelRows / 3));
            const halfWindow = Math.floor(WINDOW_SIZE / 2);
            let startIdx = Math.max(0, selectedIndex - halfWindow);
            const endIdx = Math.min(sessions.length, startIdx + WINDOW_SIZE);
            if (endIdx - startIdx < WINDOW_SIZE) {
              startIdx = Math.max(0, endIdx - WINDOW_SIZE);
            }
            const visibleSessions = sessions.slice(startIdx, endIdx);

            return (
              <box flexDirection="column" flexGrow={1} width="100%">
                <box height={1} marginBottom={1} justifyContent="space-between" flexDirection="row" width="100%">
                  <text fg="#64748b">
                    Showing {startIdx + 1}–{endIdx} of {sessions.length} conversations
                  </text>
                  <text fg="#475569">[Enter/l] pick</text>
                </box>
                <box flexDirection="column" flexGrow={1} width="100%">
                  {visibleSessions.map((session) => {
                    const isSelected = selectedSession?.id === session.id;
                    const cursor = isSelected ? '▸ ' : '  ';
                    const titleColor = isSelected ? '#38bdf8' : '#cbd5e1';

                    return (
                      <box
                        key={session.id}
                        flexDirection="column"
                        width="100%"
                        height={2}
                        overflow="hidden"
                        backgroundColor={isSelected ? '#1e293b' : undefined}
                        paddingLeft={0}
                        paddingRight={1}
                        marginBottom={1}
                      >
                        {/* Line 1: Active status, ShortId & Title */}
                        <box height={1} width="100%" overflow="hidden">
                          <text wrapMode="none">
                            <span fg={isSelected ? '#38bdf8' : '#64748b'}>{cursor}</span>
                            <span fg={session.isActive ? '#10b981' : '#64748b'}>
                              {session.isActive ? '● ACTIVE' : '○ IDLE'}{' '}
                            </span>
                            <span fg={titleColor}>
                              {session.shortId} • {session.title.trim()}
                            </span>
                          </text>
                        </box>

                        {/* Line 2: Stats & Recency */}
                        <box
                          height={1}
                          width="100%"
                          overflow="hidden"
                          flexDirection="row"
                          justifyContent="space-between"
                        >
                          <text wrapMode="none" fg="#64748b">
                            {'    '}
                            {session.turnCount} turns
                            {session.foldedStepCount > 0 ? ` • ${session.foldedStepCount} folded` : ''}
                            {' • '}
                            {timeAgo(session.mtimeMs)}
                          </text>
                          {session.hasAudio ? (
                            <text wrapMode="none" fg="#10b981">
                              🔊 audio
                            </text>
                          ) : null}
                        </box>
                      </box>
                    );
                  })}
                </box>
              </box>
            );
          })()
        )
      ) : (
        /* LEVEL 2: Turns List */
        turns.length === 0 ? (
          <box marginTop={2} justifyContent="center" alignItems="center">
            <text fg="#64748b">No substantive turns found in this session.</text>
            <text fg="#475569">Press [Esc] to return to sessions list</text>
          </box>
        ) : (
          (() => {
            const selectedIndex = Math.max(
              0,
              turns.findIndex((t) => t.id === selectedTurn?.id)
            );
            const totalTerminalRows = process.stdout.rows || 48;
            const availablePanelRows = Math.max(18, totalTerminalRows - 12);
            const WINDOW_SIZE = Math.max(6, Math.floor(availablePanelRows / 3));
            const halfWindow = Math.floor(WINDOW_SIZE / 2);
            let startIdx = Math.max(0, selectedIndex - halfWindow);
            const endIdx = Math.min(turns.length, startIdx + WINDOW_SIZE);
            if (endIdx - startIdx < WINDOW_SIZE) {
              startIdx = Math.max(0, endIdx - WINDOW_SIZE);
            }
            const visibleTurns = turns.slice(startIdx, endIdx);

            return (
              <box flexDirection="column" flexGrow={1} width="100%">
                <box height={1} marginBottom={1} justifyContent="space-between" flexDirection="row" width="100%">
                  <text fg="#64748b">
                    Showing {startIdx + 1}–{endIdx} of {turns.length} turns
                  </text>
                  <text fg="#475569">[j/k] scroll</text>
                </box>
                <box flexDirection="column" flexGrow={1} width="100%">
                  {visibleTurns.map((turn) => {
                    const isSelected = selectedTurn?.id === turn.id;
                    const isPlaying = Boolean(turn.track && playingTrackId === turn.track.id);
                    const cursor = isSelected ? '▸ ' : '  ';
                    const badge = getStatusBadge(turn.status, isPlaying);
                    const titleColor = isSelected ? '#38bdf8' : '#cbd5e1';
                    const durationStr = turn.track
                      ? formatDuration(turn.track.durationMs)
                      : turn.status === 'synthesizing'
                      ? 'LIVE'
                      : '';

                    return (
                      <box
                        key={turn.id}
                        flexDirection="column"
                        width="100%"
                        height={2}
                        overflow="hidden"
                        backgroundColor={isSelected ? '#1e293b' : undefined}
                        paddingLeft={0}
                        paddingRight={1}
                        marginBottom={1}
                      >
                        {/* Line 1: Single text node with 4-char prefix + title */}
                        <box height={1} width="100%" overflow="hidden">
                          <text wrapMode="none">
                            <span fg={isSelected ? '#38bdf8' : '#64748b'}>{cursor}</span>
                            <span fg={badge.color}>{badge.symbol} </span>
                            <span fg={titleColor}>{turn.title.trim()}</span>
                          </text>
                        </box>

                        {/* Line 2: Turn metadata & folded steps */}
                        <box
                          height={1}
                          width="100%"
                          overflow="hidden"
                          flexDirection="row"
                          justifyContent="space-between"
                        >
                          <text wrapMode="none" fg="#64748b">
                            {'    '}
                            step #{turn.stepIndex} • {turn.wordCount} words
                            {turn.foldedStepCount && turn.foldedStepCount > 0
                              ? ` • +${turn.foldedStepCount} folded`
                              : ''}
                          </text>
                          {durationStr ? (
                            <text
                              wrapMode="none"
                              fg={turn.status === 'synthesizing' ? '#f59e0b' : '#10b981'}
                            >
                              {durationStr}
                            </text>
                          ) : null}
                        </box>
                      </box>
                    );
                  })}
                </box>
              </box>
            );
          })()
        )
      )}
    </box>
  );
}
