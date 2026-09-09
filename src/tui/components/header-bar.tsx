import type { StudioLiveState, StudioPlaybackState } from '../../studio/types.js';

export interface HeaderBarProps {
  live: StudioLiveState;
  playback: StudioPlaybackState;
  trackCount: number;
  copyNotification?: string | null;
}

export function HeaderBar({ live, playback, trackCount, copyNotification }: HeaderBarProps) {
  let statusBadge = '■ IDLE';
  let statusColor = '#9ca3af'; // gray

  if (copyNotification) {
    statusBadge = `✓ ${copyNotification.toUpperCase()}`;
    statusColor = '#10b981'; // green
  } else if (live.isStreaming) {
    statusBadge = '● STREAMING LIVE';
    statusColor = '#10b981'; // green
  } else if (playback.status === 'playing') {
    statusBadge = '▶ PLAYING';
    statusColor = '#06b6d4'; // cyan
  } else if (playback.status === 'paused') {
    statusBadge = '⏸ PAUSED';
    statusColor = '#f59e0b'; // amber
  }

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      height={3}
      borderStyle="single"
      borderColor="#3b82f6"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" gap={1}>
        <text fg="#38bdf8">
          <b>mdmedia Audio Studio</b>
        </text>
        <text fg="#64748b">v0.1.0</text>
      </box>

      <box flexDirection="row" gap={2}>
        <text fg={statusColor}>
          <b>{statusBadge}</b>
        </text>
        {live.activeSessionId && (
          <text fg="#64748b">
            session: {live.activeSessionId.slice(0, 8)}
          </text>
        )}
      </box>

      <box flexDirection="row" gap={2}>
        <text fg="#e2e8f0">{playback.rate.toFixed(2)}x</text>
        <text fg="#94a3b8">{trackCount} turns</text>
      </box>
    </box>
  );
}
