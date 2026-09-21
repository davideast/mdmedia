"use client";

import { cn } from "cn";
import {
  AudioLines,
  FastForward,
  Pause,
  Play,
  Rewind,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StreamingPcmPlayer } from "@/lib/pcm-player";

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TransportButton({
  label,
  onClick,
  disabled,
  children,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "inline-flex flex-none items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-35",
          primary
            ? "size-9 bg-primary text-primary-foreground hover:opacity-90"
            : "size-7 text-ink-muted hover:bg-accent hover:text-accent-foreground",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Music-player-style narration dock.
 *
 * Persistently anchored at the bottom center of the middle panel across routes.
 * Displays track title (linking back to `/narration/[id]`), voice / playlist
 * subtitle, full transport controls (previous, -10s, play/pause, +10s, next),
 * timeline scrubber, mute, and playback speed.
 */
export function AudioPlayerBar({
  player,
  positionMs,
  durationMs,
  playing,
  busy,
  title,
  subtitle,
  href,
  onPrevious,
  onNext,
  hasNext = false,
  className,
}: {
  player: StreamingPcmPlayer | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  /** Synthesis still running — the track is not yet its final length. */
  busy: boolean;
  title?: string;
  subtitle?: string;
  href?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  hasNext?: boolean;
  className?: string;
}) {
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);

  const ready = player !== null && durationMs > 0;
  const displayTitle = title && title.trim().length > 0 ? title : "Untitled narration";

  const toggle = useCallback(() => {
    if (player === null) return;
    if (playing) player.pause();
    else void player.play();
  }, [player, playing]);

  const cycleRate = useCallback(() => {
    if (player === null) return;
    const next = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length];
    player.setRate(next);
    setRate(next);
  }, [player, rate]);

  const toggleMute = useCallback(() => {
    if (player === null) return;
    const next = !muted;
    player.setVolume(next ? 0 : 1);
    setMuted(next);
  }, [player, muted]);

  return (
    <div
      className={cn(
        "pointer-events-auto grid w-[min(48rem,100%)] grid-cols-[minmax(9rem,13.5rem)_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border border-border bg-popover/95 px-3.5 py-2.5 shadow-[0_10px_32px_rgba(0,0,0,0.16)] backdrop-blur-md",
        className,
      )}
    >
      {/* Track information (clicking title links back to /narration/[id]) */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className={cn(
            "flex size-9 flex-none items-center justify-center rounded-lg border border-border bg-surface-inset text-foreground",
            playing && "border-border-strong",
          )}
        >
          <AudioLines size={16} strokeWidth={2} className={cn(playing && "animate-pulse")} />
        </div>
        <div className="grid min-w-0 gap-0.5">
          {href ? (
            <Link
              href={href}
              className="truncate text-[13px] leading-tight font-semibold text-foreground transition-colors hover:underline"
              title={displayTitle}
            >
              {displayTitle}
            </Link>
          ) : (
            <span className="truncate text-[13px] leading-tight font-semibold text-foreground">
              {displayTitle}
            </span>
          )}
          <span className="t-meta truncate text-[11px] leading-tight">
            {subtitle && subtitle.length > 0 ? subtitle : busy ? "Synthesizing…" : "Narration"}
          </span>
        </div>
      </div>

      {/* Transport + Scrubber */}
      <div className="flex min-w-0 items-center gap-1.5">
        {onPrevious ? (
          <TransportButton
            label="Previous / Restart"
            onClick={onPrevious}
            disabled={!ready}
          >
            <SkipBack size={14} strokeWidth={2} />
          </TransportButton>
        ) : null}

        <TransportButton
          label="Back 10 seconds"
          onClick={() => player?.scrub(-10_000)}
          disabled={!ready}
        >
          <Rewind size={15} strokeWidth={2} />
        </TransportButton>

        <TransportButton
          label={playing ? "Pause" : "Play"}
          onClick={toggle}
          disabled={!ready}
          primary
        >
          {playing ? (
            <Pause size={16} strokeWidth={2} />
          ) : (
            <Play size={16} strokeWidth={2} className="translate-x-px" />
          )}
        </TransportButton>

        <TransportButton
          label="Forward 10 seconds"
          onClick={() => player?.scrub(10_000)}
          disabled={!ready}
        >
          <FastForward size={15} strokeWidth={2} />
        </TransportButton>

        {onNext ? (
          <TransportButton
            label="Next in playlist"
            onClick={onNext}
            disabled={!ready || !hasNext}
          >
            <SkipForward size={14} strokeWidth={2} />
          </TransportButton>
        ) : null}

        <Slider
          aria-label="Position"
          value={[Math.min(positionMs, durationMs)]}
          min={0}
          max={Math.max(durationMs, 1)}
          step={100}
          disabled={!ready}
          onValueChange={([next]) => player?.seek(next)}
          className="min-w-20 flex-1 px-1.5"
        />

        <span className="t-mono flex-none text-[11px] tabular-nums whitespace-nowrap">
          {clock(positionMs)} / {busy ? "\u2013\u2013:\u2013\u2013" : clock(durationMs)}
        </span>
      </div>

      {/* Volume + Speed */}
      <div className="flex flex-none items-center gap-1">
        <TransportButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute} disabled={!ready}>
          {muted ? <VolumeX size={15} strokeWidth={2} /> : <Volume2 size={15} strokeWidth={2} />}
        </TransportButton>

        <Tooltip>
          <TooltipTrigger
            onClick={cycleRate}
            disabled={!ready}
            aria-label="Playback speed"
            className="t-mono inline-flex h-7 min-w-10 flex-none items-center justify-center rounded-full px-2 text-[11px] tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-35"
          >
            {rate}&times;
          </TooltipTrigger>
          <TooltipContent side="top">Playback speed</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
