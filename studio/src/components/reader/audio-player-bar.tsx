"use client";

import { cn } from "cn";
import {
  AudioLines,
  FastForward,
  Minus,
  Pause,
  Play,
  Plus,
  Rewind,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StreamingPcmPlayer } from "@/lib/pcm-player";

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.5;
const SPEED_STEP = 0.05;

function roundSpeed(val: number): number {
  return Math.round(val * 100) / 100;
}

function formatSpeed(val: number): string {
  return `${roundSpeed(val).toFixed(2)}×`;
}

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

function PlaybackSpeedPopover({
  rate,
  onRateChange,
  disabled,
}: {
  rate: number;
  onRateChange: (next: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  const setClampedRate = (value: number) => {
    const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, roundSpeed(value)));
    onRateChange(clamped);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Playback speed"
              className={cn(
                "t-mono inline-flex h-7 w-14 flex-none items-center justify-center rounded-full text-[11px] font-medium tabular-nums transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-35 cursor-pointer",
                open
                  ? "bg-accent text-accent-foreground ring-1 ring-ring/30"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {formatSpeed(rate)}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open && <TooltipContent side="top">Playback speed</TooltipContent>}
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="flex w-[364px] flex-col gap-4 p-4 shadow-2xl"
      >
        {/* Header: Label + Monospace Active Value (No Reset button) */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            Playback Speed
          </span>
          <span className="t-mono min-w-[3.5rem] text-right text-[13px] font-semibold tabular-nums text-foreground">
            {formatSpeed(rate)}
          </span>
        </div>

        {/* Stepper + Granular Slider */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={disabled || rate <= MIN_SPEED}
              onClick={() => setClampedRate(rate - SPEED_STEP)}
              aria-label="Decrease speed by 0.05"
              className="flex size-7.5 flex-none items-center justify-center rounded-lg border border-border bg-surface-inset text-ink-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-30 cursor-pointer"
            >
              <Minus size={13} strokeWidth={2.2} />
            </button>

            <Slider
              aria-label="Playback speed slider"
              value={[rate]}
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={SPEED_STEP}
              disabled={disabled}
              onValueChange={([next]) => setClampedRate(next)}
              className="flex-1 px-1"
            />

            <button
              type="button"
              disabled={disabled || rate >= MAX_SPEED}
              onClick={() => setClampedRate(rate + SPEED_STEP)}
              aria-label="Increase speed by 0.05"
              className="flex size-7.5 flex-none items-center justify-center rounded-lg border border-border bg-surface-inset text-ink-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-30 cursor-pointer"
            >
              <Plus size={13} strokeWidth={2.2} />
            </button>
          </div>

          <div className="flex justify-between px-8 text-[11px] text-ink-faint t-mono tabular-nums">
            <span>{MIN_SPEED.toFixed(1)}×</span>
            <span>{MAX_SPEED.toFixed(1)}×</span>
          </div>
        </div>

        {/* Discrete Quick Presets */}
        <div className="grid grid-cols-6 gap-1.5 border-t border-border-hairline pt-3.5">
          {SPEED_PRESETS.map((preset) => {
            const active = Math.abs(rate - preset) < 0.01;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setClampedRate(preset)}
                className={cn(
                  "t-mono flex h-7 items-center justify-center rounded-lg text-[11px] font-medium tabular-nums transition-colors cursor-pointer",
                  active
                    ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                    : "bg-surface-inset text-ink-muted hover:bg-muted hover:text-foreground",
                )}
              >
                {preset}×
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
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
  const [rate, setRate] = useState(player?.rate ?? 1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (player && rate !== 1) {
      player.setRate(rate);
    }
  }, [player, rate]);

  const ready = player !== null && durationMs > 0;
  const displayTitle = title && title.trim().length > 0 ? title : "Untitled narration";

  const toggle = useCallback(() => {
    if (player === null) return;
    if (playing) player.pause();
    else void player.play();
  }, [player, playing]);

  const handleRateChange = useCallback(
    (next: number) => {
      setRate(next);
      player?.setRate(next);
    },
    [player],
  );

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

        <PlaybackSpeedPopover
          rate={rate}
          onRateChange={handleRateChange}
          disabled={!ready}
        />
      </div>
    </div>
  );
}
