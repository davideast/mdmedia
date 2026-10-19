'use client';

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Film, Minus, Pause, Play, Plus } from 'lucide-react';
import { cn } from 'cn';
import { gainAt, type CutError, type ResolvedAudio, type ResolvedLine, type ResolvedOverlay, type ResolvedSegment, type Timeline } from 'mdmedia/cut';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  activeIndex,
  fitLabels,
  gainPath,
  gapLabel,
  labelRoom,
  lineGaps,
  packLanes,
  rulerSteps,
  secondsLabel,
  silentStretches,
  speakerLanes,
  spokenLines,
  stepTenth,
  tenths,
} from '@/lib/cut-timeline';

/**
 * A read-only view of one cut: the rendered video, framed as the CRT shows it,
 * over a timeline of its lines, shots, music and overlays. The owner watches,
 * reads exact times, and sends timing notes in chat; nothing here edits.
 */

type Frame = 'tv' | 'full';
const ASPECT: Record<Frame, number> = { tv: 4 / 3, full: 16 / 9 };

/** Row heights in pixels, shared by the track names and the tracks. */
const ROW = { ruler: 28, lane: 72, gaps: 20, shots: 70, music: 46, overlayLane: 15 } as const;
/** On a phone the timeline keeps this scale and scrolls inside its own frame. */
const PHONE_PX_PER_SECOND = 52;
/** Zoom steps, as multiples of the fitted width (1 fits the whole cut). */
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8] as const;

const span = (start: number, end: number) => `${tenths(start)} → ${tenths(end)} · ${secondsLabel(end - start)}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function CutViewer({ name, timeline: cut }: { name: string; timeline: Timeline }) {
  // Lines are shown, measured and highlighted by when they're spoken, not by their whole audio.
  const timeline = useMemo(() => ({ ...cut, lines: spokenLines(cut.lines) }), [cut]);
  const { length, segments, lines, music, overlays, sfx, meta } = timeline;
  const videoRef = useRef<HTMLVideoElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const flagRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<Frame>('tv');
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(0);
  /** Where the playhead sat on screen before a zoom, so it stays put after. */
  const zoomAnchor = useRef<{ t: number; offset: number } | null>(null);
  const [now, setNow] = useState({ shot: -1, line: -1, music: -1 });
  const [videoError, setVideoError] = useState(false);

  const scrub = useRef<{ pointerId: number; wasPlaying: boolean; t: number } | null>(null);
  const tap = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const sample = useRef({ media: -1, at: 0 });
  const drawn = useRef({ x: -1, label: '', t: 0 });
  const followUntil = useRef(0);

  const src = `/api/dev/cuts/${encodeURIComponent(name)}/video`;

  // --- seeking -------------------------------------------------------------

  const seek = useCallback((t: number, fast = false) => {
    const video = videoRef.current;
    const next = clamp(t, 0, length);
    if (!video) return;
    if (video.seeking) {
      pendingSeek.current = next;
      return;
    }
    if (fast && typeof video.fastSeek === 'function') video.fastSeek(next);
    else video.currentTime = next;
  }, [length]);

  const currentTime = useCallback(() => {
    const video = videoRef.current;
    if (!video) return 0;
    // While seeking, currentTime already reports the time being sought.
    return pendingSeek.current ?? video.currentTime;
  }, []);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, []);

  // --- the playhead, drawn every frame ------------------------------------

  useEffect(() => {
    let frameId = 0;
    const draw = () => {
      const video = videoRef.current;
      const lanes = lanesRef.current;
      if (video && lanes) {
        let t: number;
        if (scrub.current) t = scrub.current.t;
        else if (!video.paused && !video.seeking) {
          // currentTime moves in steps; between them, run the clock on so the line glides.
          const at = performance.now();
          if (video.currentTime !== sample.current.media) sample.current = { media: video.currentTime, at };
          t = sample.current.media + Math.min(0.25, (at - sample.current.at) / 1000) * video.playbackRate;
        } else t = currentTime();
        t = clamp(t, 0, length);

        const dpr = window.devicePixelRatio || 1;
        const x = Math.round((t / length) * lanes.clientWidth * dpr) / dpr;
        const label = tenths(t);
        const relabel = label !== drawn.current.label;
        if (relabel && flagRef.current) flagRef.current.textContent = label;
        if ((x !== drawn.current.x || relabel) && playheadRef.current) {
          playheadRef.current.style.transform = `translate3d(${x}px,0,0)`;
          drawn.current.x = x;
          // The flag centres on the line but stays inside the ruler at either end.
          const flag = flagRef.current;
          if (flag) {
            const half = flag.offsetWidth / 2;
            const shift = clamp(-half, 2 - x, lanes.clientWidth - 2 - x - 2 * half);
            flag.style.transform = `translate3d(${shift}px,0,0)`;
          }
        }
        if (relabel) {
          drawn.current.label = label;
          if (clockRef.current) clockRef.current.textContent = label;
          rootRef.current?.querySelectorAll<HTMLElement>('[data-gain]').forEach((element) => {
            const clip = music[Number(element.dataset.gain)];
            if (clip) element.textContent = gainAt(clip, t).toFixed(2);
          });
          const next = { shot: activeIndex(segments, t), line: activeIndex(lines, t), music: activeIndex(music, t) };
          setNow((previous) => (previous.shot === next.shot && previous.line === next.line && previous.music === next.music ? previous : next));
        }

        // On a phone the timeline scrolls; keep the playhead in view while it plays or jumps.
        const scroller = scrollerRef.current;
        const jumped = Math.abs(t - drawn.current.t) > 0.05;
        drawn.current.t = t;
        if (scroller && !scrub.current && (jumped || !video.paused) && scroller.scrollWidth > scroller.clientWidth + 1) {
          const at = performance.now();
          const left = scroller.scrollLeft;
          if (at > followUntil.current && (x < left + 16 || x > left + scroller.clientWidth - 40)) {
            followUntil.current = at + 450;
            scroller.scrollTo({ left: Math.max(0, x - scroller.clientWidth * 0.3), behavior: video.paused ? 'auto' : 'smooth' });
          }
        }
      }
      frameId = requestAnimationFrame(draw);
    };
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [currentTime, length, lines, music, segments]);

  useEffect(() => {
    const lanes = lanesRef.current;
    if (!lanes) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(lanes);
    return () => observer.disconnect();
  }, []);

  // --- zoom -----------------------------------------------------------------

  const zoomTo = useCallback((step: number) => {
    const next = clamp(step, 0, ZOOMS.length - 1);
    const scroller = scrollerRef.current, lanes = lanesRef.current;
    if (scroller && lanes) {
      const t = currentTime();
      zoomAnchor.current = { t, offset: (t / length) * lanes.offsetWidth - scroller.scrollLeft };
    }
    setZoom(next);
  }, [currentTime, length]);

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current, scroller = scrollerRef.current, lanes = lanesRef.current;
    if (!anchor || !scroller || !lanes) return;
    zoomAnchor.current = null;
    scroller.scrollLeft = (anchor.t / length) * lanes.offsetWidth - anchor.offset;
  }, [zoom, length]);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const ignored = (element: EventTarget | null) =>
      element instanceof HTMLElement && Boolean(element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || ignored(event.target)) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) toggle();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        seek(stepTenth(currentTime(), event.key === 'ArrowRight' ? 1 : -1, event.shiftKey ? 1 : 0.1));
      } else if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        zoomTo(zoom + 1);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomTo(zoom - 1);
      } else if (event.key === '0') {
        event.preventDefault();
        zoomTo(0);
      }
    };
    // Space on a focused button would also click it; the shortcut wins.
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.code === 'Space' || event.key === ' ') && !ignored(event.target)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [currentTime, seek, toggle, zoom, zoomTo]);

  // --- pointer: click or drag anywhere on the timeline to seek ---------------

  const timeAt = useCallback((clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * length, 0, length);
  }, [length]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const onRuler = event.target instanceof HTMLElement && event.target.closest('[data-ruler]');
    // A finger on the tracks may be scrolling them: seek on a tap, scrub only on the ruler.
    if (event.pointerType === 'touch' && !onRuler) {
      tap.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const video = videoRef.current;
    scrub.current = { pointerId: event.pointerId, wasPlaying: Boolean(video && !video.paused), t: timeAt(event.clientX) };
    video?.pause();
    seek(scrub.current.t);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (scrub.current?.pointerId !== event.pointerId) return;
    scrub.current.t = timeAt(event.clientX);
    seek(scrub.current.t, true);
  };
  const endScrub = (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = scrub.current;
    if (current?.pointerId === event.pointerId) {
      scrub.current = null;
      if (commit) seek(current.t);
      if (current.wasPlaying) void videoRef.current?.play().catch(() => setPlaying(false));
    }
    const touch = tap.current;
    if (touch?.pointerId === event.pointerId) {
      tap.current = null;
      if (commit && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 8) seek(timeAt(event.clientX));
    }
  };

  // --- layout ---------------------------------------------------------------

  const speakers = useMemo(() => speakerLanes(lines), [lines]);
  const pxPerSecond = width > 0 ? width / length : 40;
  const aspect = ASPECT[frame];
  const activeShot = now.shot >= 0 ? segments[now.shot] : null;
  const activeLine = now.line >= 0 ? lines[now.line] : null;

  // The side panel keeps to one grid: a label column, a value column that truncates, and a
  // right-aligned column of times. Every row is a fixed 32px, and the line's words, which vary,
  // come last in a fixed three-line box, so nothing moves as the playhead runs.
  const transport = (
    <div className="flex h-12 items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="inline-flex size-10 flex-none items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        {playing ? <Pause size={17} strokeWidth={2.25} className="fill-current" /> : <Play size={17} strokeWidth={2.25} className="ml-0.5 fill-current" />}
      </button>
      <p className="min-w-0 flex-1 tabular-nums" aria-label="Playhead time in seconds">
        <span ref={clockRef} className="text-[30px] leading-none font-semibold tracking-[-0.02em] text-foreground lg:text-[34px]">0.0</span>
        <span className="ml-1.5 text-[16px] leading-none font-medium text-ink-faint lg:text-[17px]">/ {tenths(length)}</span>
      </p>
      <div role="group" aria-label="Frame" className="flex h-8 flex-none items-center rounded-full bg-foreground/[0.07] p-0.5 text-[12px] font-medium">
        {(['tv', 'full'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={frame === value}
            onClick={() => setFrame(value)}
            className={cn(
              'h-7 rounded-full px-3 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
              frame === value ? 'bg-foreground/[0.14] text-foreground' : 'text-ink-muted hover:text-foreground',
            )}
          >
            {value === 'tv' ? '4:3 TV' : '16:9'}
          </button>
        ))}
      </div>
    </div>
  );

  const label = 'flex h-8 items-center text-[13px] text-ink-muted';
  const value = 'flex h-8 min-w-0 items-center gap-1.5 text-[13px] text-foreground';
  const times = 'flex h-8 items-center justify-end font-mono text-[12px] text-ink-faint tabular-nums';
  const range = (start: number, end: number) => `${tenths(start)}–${tenths(end)}`;

  const nowSection = (
    <section aria-label="Now">
      <h3 className="flex h-8 items-center text-[13px] font-semibold text-foreground">Now</h3>
      <div className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-x-3">
        <span className={label}>Shot</span>
        <span className={value}>
          {activeShot ? (
            <><span className="flex-none font-mono text-[12px] text-ink-muted">{activeShot.id}</span><span className="truncate">{activeShot.label}</span></>
          ) : <span className="text-ink-faint">None</span>}
        </span>
        <span className={times} title={activeShot ? `${secondsLabel(activeShot.end - activeShot.start)} long` : undefined}>
          {activeShot ? range(activeShot.start, activeShot.end) : '—'}
        </span>

        <span className={label}>Music</span>
        <span className={value}>
          {music.map((clip, i) => (
            <span key={clip.id} className={cn('truncate', now.music !== i && 'hidden')}>{clip.label || clip.id}</span>
          ))}
          {now.music < 0 ? <span className="text-ink-faint">Silent</span> : null}
        </span>
        <span className={times}>
          {music.map((clip, i) => (
            <span key={clip.id} className={cn(now.music !== i && 'hidden')}>gain <span data-gain={i}>0.00</span></span>
          ))}
          {now.music < 0 ? '—' : null}
        </span>

        <span className={label}>Line</span>
        <span className={value}>
          {activeLine ? activeLine.speaker : <span className="text-ink-faint">No one speaking</span>}
        </span>
        <span className={times} title={activeLine ? `${secondsLabel(activeLine.end - activeLine.start)} long` : undefined}>
          {activeLine ? range(activeLine.start, activeLine.end) : '—'}
        </span>
        {/* The words: always three lines tall, so a long line or no line never shifts the layout. */}
        <p
          className="col-span-2 col-start-2 line-clamp-3 h-[57px] pt-0.5 text-[13px] leading-[19px] text-foreground/90"
          title={activeLine && activeLine.text.length > 90 ? activeLine.text : undefined}
        >
          {activeLine?.text}
        </p>
      </div>
    </section>
  );

  const cutSection = (
    <section aria-label="Cut">
      <div className="flex h-8 items-center justify-between">
        <h3 className="text-[13px] font-semibold text-foreground">Cut</h3>
        <KeysButton />
      </div>
      {meta.notes ? (
        <Tip label={<span className="block max-w-[22rem]">{meta.notes}</span>}>
          <p tabIndex={0} className="line-clamp-2 text-[13px] leading-[19px] text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {meta.notes}
          </p>
        </Tip>
      ) : null}
      <p className="mt-2 truncate font-mono text-[12px] leading-[19px] text-ink-faint">
        {[`${tenths(length)} s`, `${meta.fps} fps`, `${meta.width}×${meta.height}`, `${name}.cut.json`].join(' · ')}
      </p>
    </section>
  );

  return (
    <WorkbenchPanel
      className="dark"
      title={[meta.title, meta.version].filter(Boolean).join(' · ')}
      icon={<Film size={13} strokeWidth={2} />}
      bodyClassName="p-0"
    >
      {/* Three boxes on one grid with equal gutters: the stage and the panel on top, the timeline under
          both. The stage's left edge and the panel's right edge are the timeline's edges. */}
      <div ref={rootRef} className="flex min-h-full flex-1 flex-col gap-4 px-4 pt-4 pb-5 lg:px-6" style={{ '--cut-now': '#f6c453' } as CSSProperties}>
        <div className="flex flex-col gap-4 lg:min-h-[340px] lg:flex-1 lg:flex-row">
          {/* The stage: black, the picture centred in it, so a 4:3 frame is pillarboxed inside the stage
              rather than leaving the page around it empty. The frame toggle only changes the picture. */}
          <div className="relative aspect-[4/3] max-h-[62dvh] w-full overflow-hidden rounded-[10px] bg-black ring-1 ring-white/[0.08] [container-type:size] lg:aspect-auto lg:max-h-none lg:min-w-0 lg:flex-1">
          <div
            className="absolute top-1/2 left-1/2 w-[min(100cqw,calc(100cqh*var(--aspect)))] -translate-x-1/2 -translate-y-1/2 overflow-hidden transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ '--aspect': aspect, aspectRatio: String(aspect) } as CSSProperties}
          >
            <video
              ref={videoRef}
              src={src}
              preload="auto"
              playsInline
              onClick={toggle}
              onPlay={() => { setPlaying(true); sample.current.media = -1; }}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onSeeked={() => {
                const next = pendingSeek.current;
                if (next !== null) { pendingSeek.current = null; seek(next, Boolean(scrub.current)); }
              }}
              onError={() => setVideoError(true)}
              aria-label={`${meta.title} ${meta.version ?? ''}`.trim()}
              className={cn('absolute inset-0 h-full w-full cursor-pointer', frame === 'tv' ? 'object-cover' : 'object-contain')}
            />
            {frame === 'full' ? (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[12.5%] right-[12.5%] border-x border-dashed border-white/30" />
            ) : null}
            {videoError ? (
              <p role="alert" className="absolute inset-0 grid place-content-center p-6 text-center text-sm text-ink-muted">
                The rendered video isn&apos;t in the media folder.
              </p>
            ) : null}
          </div>
          </div>
          {/* The panel: a docked box the same as the timeline's. On a phone only the transport is here,
              unboxed under the picture; the rest goes in a box under the timeline. */}
          <aside className="flex min-w-0 flex-col gap-6 lg:w-[23rem] lg:flex-none lg:overflow-hidden lg:rounded-[10px] lg:border lg:border-border lg:bg-surface-inset lg:p-4 lg:[container:aside/size]">
            {transport}
            <div className="hidden lg:block">{nowSection}</div>
            {/* The cut's notes only where there's room; what's playing now comes first. */}
            <div className="mt-auto hidden [@container_aside_(min-height:360px)]:block">{cutSection}</div>
          </aside>
        </div>

        <section aria-label="Timeline" className="flex-none overflow-hidden rounded-[10px] border border-border bg-surface-inset select-none">
          <div className="flex">
            <TrackNames
              speakers={speakers}
              overlayTitle={sfx.length ? 'Overlays · SFX' : 'Overlays'}
              overlayLanes={overlayLaneCount(overlays, sfx)}
              zoom={zoom}
              onZoom={zoomTo}
            />
            <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]">
              <div
                ref={lanesRef}
                className="relative w-[calc(max(100%,var(--phone-width))*var(--zoom))] cursor-text lg:w-[calc(100%*var(--zoom))]"
                style={{ '--phone-width': `${Math.ceil(length * PHONE_PX_PER_SECOND)}px`, '--zoom': ZOOMS[zoom] } as CSSProperties}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => endScrub(event, true)}
                onPointerCancel={(event) => endScrub(event, false)}
              >
                <Tracks timeline={timeline} speakers={speakers} pxPerSecond={pxPerSecond} now={now} name={name} onSeek={seek} />
                <div ref={playheadRef} aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-20 will-change-transform">
                  <div className="absolute inset-y-0 -left-px w-px bg-[var(--cut-now)] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
                  <span
                    ref={flagRef}
                    className="absolute top-[5px] left-0 rounded-[4px] bg-[var(--cut-now)] px-1.5 py-px font-mono text-[10.5px] leading-[15px] font-semibold text-[#1c1917] tabular-nums"
                  >
                    0.0
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="flex flex-col gap-6 rounded-[10px] border border-border bg-surface-inset p-4 lg:hidden">
          {nowSection}
          {cutSection}
        </div>
      </div>
    </WorkbenchPanel>
  );
}

/** A quiet text action that opens the keyboard shortcuts. Hidden on touch-sized layouts, where there are no keys. */
function KeysButton() {
  const key = 'inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[4px] border border-border bg-foreground/[0.04] px-1 font-mono text-[11px] text-ink-muted';
  const rows: [ReactNode, string][] = [
    [<kbd key="space" className={key}>Space</kbd>, 'Play or pause'],
    [<><kbd className={key}>←</kbd><kbd className={key}>→</kbd></>, 'Step 0.1 s'],
    [<><kbd className={key}>⇧</kbd><kbd className={key}>←</kbd><kbd className={key}>→</kbd></>, 'Step 1 s'],
    [<><kbd className={key}>−</kbd><kbd className={key}>+</kbd></>, 'Zoom the timeline'],
    [<kbd key="zero" className={key}>0</kbd>, 'Fit the whole cut'],
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hidden h-7 items-center rounded-[4px] text-[12px] text-ink-muted transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden data-[state=open]:text-foreground lg:inline-flex"
        >
          Keys
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="dark w-60 p-2">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 px-1 py-0.5 text-[13px]">
          {rows.map(([keys, what]) => (
            <Fragment key={what}>
              <dt className="flex h-7 items-center gap-1">{keys}</dt>
              <dd className="text-foreground/90">{what}</dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function overlayLaneCount(overlays: readonly ResolvedOverlay[], sfx: readonly ResolvedAudio[]): number {
  const items = [...overlays, ...sfx];
  if (items.length === 0) return 0;
  return Math.max(...packLanes(items).values()) + 1;
}

function TrackNames({
  speakers,
  overlayTitle,
  overlayLanes,
  zoom,
  onZoom,
}: {
  speakers: string[];
  overlayTitle: string;
  overlayLanes: number;
  zoom: number;
  onZoom: (step: number) => void;
}) {
  const name = 'flex items-center px-2.5 text-[11.5px] font-medium text-ink-muted lg:px-3';
  const button =
    'inline-flex size-[22px] items-center justify-center rounded-[5px] text-ink-muted transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-30';
  return (
    <div className="relative z-30 w-[60px] flex-none border-r border-border bg-surface-inset lg:w-[72px]">
      {/* Zoom sits in the ruler's corner: out, then in. 0 fits the whole cut again. */}
      <div role="group" aria-label="Timeline zoom" style={{ height: ROW.ruler }} className="flex items-center justify-center gap-0.5 border-b border-border">
        <Tip label={<TipBody title="Zoom out" times="−  ·  0 fits the cut" />}>
          <button type="button" className={button} aria-label="Zoom out" disabled={zoom === 0} onClick={() => onZoom(zoom - 1)}>
            <Minus size={13} strokeWidth={2} />
          </button>
        </Tip>
        <Tip label={<TipBody title="Zoom in" times={`+  ·  now ${ZOOMS[zoom]}×`} />}>
          <button type="button" className={button} aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => onZoom(zoom + 1)}>
            <Plus size={13} strokeWidth={2} />
          </button>
        </Tip>
      </div>
      {speakers.map((speaker, i) => (
        <div key={speaker}>
          <div style={{ height: ROW.lane }} className={cn(name, 'items-start pt-[7px] text-foreground')}>{speaker}</div>
          {i === 0 ? <div style={{ height: ROW.gaps }} className="flex items-center px-3 text-[10.5px] text-ink-faint">gap</div> : null}
        </div>
      ))}
      <div style={{ height: ROW.shots }} className={cn(name, 'items-start border-t border-border pt-[17px]')}>Shots</div>
      <div style={{ height: ROW.music }} className={cn(name, 'border-t border-border')}>Music</div>
      {overlayLanes > 0 ? (
        <div style={{ height: overlayLanes * ROW.overlayLane + 12 }} className={cn(name, 'border-t border-border')}>{overlayTitle}</div>
      ) : null}
    </div>
  );
}

function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[18rem] text-left">{label}</TooltipContent>
    </Tooltip>
  );
}

function TipBody({ title, body, times }: { title: ReactNode; body?: ReactNode; times: string }) {
  return (
    <span className="grid gap-0.5">
      <span className="font-semibold">{title}</span>
      {body ? <span>{body}</span> : null}
      <span className="font-mono text-[10.5px] opacity-70 tabular-nums">{times}</span>
    </span>
  );
}

const Tracks = memo(function Tracks({
  timeline,
  speakers,
  pxPerSecond,
  now,
  name,
  onSeek,
}: {
  timeline: Timeline;
  speakers: string[];
  pxPerSecond: number;
  now: { shot: number; line: number };
  name: string;
  onSeek: (t: number) => void;
}) {
  const { length, segments, lines, music, overlays, sfx } = timeline;
  const pct = (seconds: number) => `${(seconds / length) * 100}%`;
  const steps = rulerSteps(pxPerSecond);

  const majors = useMemo(() => {
    const list: number[] = [];
    for (let t = 0; t <= length + 1e-6; t += steps.major) list.push(Math.round(t * 10) / 10);
    return list;
  }, [length, steps.major]);
  const minors = useMemo(() => {
    const list: number[] = [];
    for (let t = 0; t <= length + 1e-6; t += steps.minor) list.push(Math.round(t * 10) / 10);
    return list;
  }, [length, steps.minor]);

  const gaps = useMemo(() => lineGaps(lines), [lines]);
  const gapShown = useMemo(
    () => fitLabels(gaps.map((gap) => ({ x: ((gap.start + gap.end) / 2) * pxPerSecond, width: gapLabel(gap.length).length * 6.2 + 6, priority: gap.length }))),
    [gaps, pxPerSecond],
  );
  const lineRoom = useMemo(() => {
    const room = new Map<ResolvedLine, number>();
    for (const speaker of speakers) {
      for (const [line, seconds] of labelRoom(lines.filter((item) => item.speaker === speaker), length)) room.set(line, seconds);
    }
    return room;
  }, [length, lines, speakers]);
  const envelopes = useMemo(() => music.map((clip) => gainPath(clip)), [music]);
  const silences = useMemo(() => silentStretches(music, length), [length, music]);
  const overlayItems = useMemo(() => [...overlays, ...sfx], [overlays, sfx]);
  const overlayLane = useMemo(() => packLanes(overlayItems), [overlayItems]);
  const overlayRoom = useMemo(() => {
    const room = new Map<ResolvedOverlay | ResolvedAudio, number>();
    const lanes = new Set(overlayLane.values());
    for (const lane of lanes) {
      for (const [item, seconds] of labelRoom(overlayItems.filter((entry) => overlayLane.get(entry) === lane), length)) room.set(item, seconds);
    }
    return room;
  }, [length, overlayItems, overlayLane]);
  const overlayLanes = overlayItems.length ? Math.max(...overlayLane.values()) + 1 : 0;
  const musicLabels = useMemo(
    () => labelRoom([...music.map((clip) => ({ start: clip.start, end: clip.end })), ...silences], length),
    [length, music, silences],
  );

  const seekKeys = (t: number) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSeek(t);
    }
  };
  const roomOf = (start: number) => [...musicLabels.entries()].find(([item]) => Math.abs(item.start - start) < 1e-6)?.[1] ?? length - start;

  return (
    <div className="relative">
      {/* second gridlines, behind everything */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {majors.map((t) => (
          <span key={t} className="absolute inset-y-0 w-px bg-foreground/[0.045]" style={{ left: pct(t) }} />
        ))}
      </div>

      {/* ruler */}
      <div data-ruler className="relative cursor-ew-resize touch-none border-b border-border" style={{ height: ROW.ruler }}>
        {minors.map((t) => (
          <span
            key={t}
            className={cn('absolute bottom-0 w-px', majors.includes(t) ? 'h-2 bg-foreground/30' : 'h-1 bg-foreground/15')}
            style={{ left: pct(t) }}
          />
        ))}
        {majors.map((t) =>
          length - t < (steps.major * 0.6) ? null : (
            <span key={t} className="absolute top-[7px] pl-1 font-mono text-[10px] leading-none text-ink-faint tabular-nums" style={{ left: pct(t) }}>
              {t}
            </span>
          ),
        )}
        <span className="absolute top-[7px] right-1 font-mono text-[10px] leading-none text-ink-muted tabular-nums">{tenths(length)}</span>
      </div>

      {/* lines: one lane per speaker, the gaps between the first two */}
      {speakers.map((speaker, laneIndex) => (
        <div key={speaker}>
          <div className="relative" style={{ height: ROW.lane }}>
            {lines.filter((line) => line.speaker === speaker).map((line) => {
              const active = lines[now.line] === line;
              const room = lineRoom.get(line) ?? line.end - line.start;
              return (
                <div key={line.id}>
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-[6px] h-[17px] rounded-r-[3px] border-l-2 transition-colors duration-150',
                      active ? 'border-[var(--cut-now)] bg-[color-mix(in_srgb,var(--cut-now)_17%,transparent)]' : 'border-foreground/50 bg-foreground/[0.075]',
                    )}
                    style={{ left: pct(line.start), width: `max(3px, ${pct(line.end - line.start)})` }}
                  />
                  <Tip label={<TipBody title={line.speaker} body={line.text} times={span(line.start, line.end)} />}>
                    <button
                      type="button"
                      onKeyDown={seekKeys(line.start)}
                      aria-label={`${line.speaker}: ${line.text}. ${tenths(line.start)} to ${tenths(line.end)} seconds.`}
                      className="absolute top-0 flex h-full flex-col items-start overflow-hidden rounded-[4px] pt-[8px] pl-[6px] text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      style={{ left: pct(line.start), width: `calc(${pct(room)} - 6px)` }}
                    >
                      <span className={cn('font-mono text-[10.5px] leading-[13px] font-medium tabular-nums', active ? 'text-[var(--cut-now)]' : 'text-ink-muted')}>{tenths(line.start)}</span>
                      <span className={cn('mt-[6px] -ml-[6px] line-clamp-3 text-[12.5px] leading-[15px] [overflow-wrap:anywhere]', active ? 'text-foreground' : 'text-foreground/[0.82]')}>
                        {line.text}
                      </span>
                    </button>
                  </Tip>
                </div>
              );
            })}
          </div>
          {laneIndex === 0 ? (
            <div className="relative" style={{ height: ROW.gaps }}>
              {gaps.map((gap, i) => {
                const long = gap.length * pxPerSecond >= 36;
                return (
                  <div key={`${gap.from.id}-${gap.to.id}`}>
                    {long ? (
                      <span
                        aria-hidden
                        className="absolute top-1/2 h-[7px] -translate-y-1/2 border-x border-t-0 border-foreground/30"
                        style={{ left: pct(gap.start), width: pct(gap.length) }}
                      >
                        <span className="absolute inset-x-0 top-1/2 h-px bg-foreground/30" />
                      </span>
                    ) : null}
                    {gapShown[i] ? (
                      <Tip label={<TipBody title={`Gap, ${gap.from.speaker} to ${gap.to.speaker}`} times={`${gap.start.toFixed(2)} → ${gap.end.toFixed(2)} · ${gap.length.toFixed(2)} s`} />}>
                        <span
                          tabIndex={0}
                          className={cn(
                            'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] px-1 font-mono leading-[14px] tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            long ? 'bg-surface-inset text-[11px] font-medium text-foreground' : 'text-[10px] text-ink-faint',
                          )}
                          style={{ left: pct((gap.start + gap.end) / 2) }}
                        >
                          {gapLabel(gap.length)}
                        </span>
                      </Tip>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}

      {/* shots */}
      <div className="relative border-t border-border" style={{ height: ROW.shots }}>
        {segments.map((segment, i) => (
          <Shot
            key={segment.id}
            segment={segment}
            name={name}
            active={now.shot === i}
            left={pct(segment.start)}
            width={pct(segment.end - segment.start)}
            pixels={(segment.end - segment.start) * pxPerSecond}
            onKeyDown={seekKeys(segment.start)}
          />
        ))}
      </div>

      {/* music: each clip's gain as a line, the silences called out */}
      <div className="relative border-t border-border" style={{ height: ROW.music }}>
        {music.map((clip) => (
          <Tip
            key={clip.id}
            label={
              <TipBody
                title={clip.label || clip.id}
                body={clip.volume.length > 1 ? `Gain ${clip.volume.map((key) => `${key.value.toFixed(2)} at ${tenths(key.t)}`).join(', ')}` : `Gain ${clip.volume[0]?.value.toFixed(2) ?? '1.00'}`}
                times={span(clip.start, clip.end)}
              />
            }
          >
            <button
              type="button"
              onKeyDown={seekKeys(clip.start)}
              aria-label={`${clip.label || clip.id}. ${tenths(clip.start)} to ${tenths(clip.end)} seconds.`}
              className="absolute top-[5px] truncate rounded-[3px] pl-1 text-left text-[10.5px] leading-[13px] text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{ left: pct(clip.start), maxWidth: `calc(${pct(roomOf(clip.start))} - 6px)` }}
            >
              {clip.label || clip.id}
            </button>
          </Tip>
        ))}
        {silences.map((silence) => (
          <span
            key={silence.start}
            className="absolute top-[5px] truncate pl-1 text-[10.5px] leading-[13px] text-ink-faint italic"
            style={{ left: pct(silence.start), maxWidth: `calc(${pct(roomOf(silence.start))} - 6px)` }}
          >
            No music · {secondsLabel(silence.end - silence.start)}
          </span>
        ))}
        <svg
          aria-hidden
          viewBox={`0 0 ${length} 1`}
          preserveAspectRatio="none"
          className="absolute inset-x-0 bottom-[4px] h-[24px] w-full overflow-visible text-foreground/60"
        >
          {envelopes.map((envelope, i) => (
            <g key={music[i].id}>
              <path d={envelope.area} className="fill-foreground/[0.08]" />
              <path d={envelope.line} fill="none" stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          ))}
          {silences.map((silence) => (
            <line
              key={silence.start}
              x1={silence.start}
              x2={silence.end}
              y1={1}
              y2={1}
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>

      {/* overlays and sound effects */}
      {overlayLanes > 0 ? (
        <div className="relative border-t border-border" style={{ height: overlayLanes * ROW.overlayLane + 12 }}>
          {overlayItems.map((item) => {
            const lane = overlayLane.get(item) ?? 0;
            const top = 6 + lane * ROW.overlayLane;
            const room = overlayRoom.get(item) ?? item.end - item.start;
            return (
              <div key={item.id}>
                <span
                  aria-hidden
                  className="absolute h-[13px] rounded-[3px] bg-foreground/[0.11]"
                  style={{ top, left: pct(item.start), width: `max(3px, calc(${pct(item.end - item.start)} - 1px))` }}
                />
                <Tip label={<TipBody title={item.label || item.id} body={item.kind === 'sfx' ? 'Sound effect' : 'Overlay'} times={span(item.start, item.end)} />}>
                  <button
                    type="button"
                    onKeyDown={seekKeys(item.start)}
                    aria-label={`${item.label || item.id}. ${tenths(item.start)} to ${tenths(item.end)} seconds.`}
                    className="absolute h-[13px] truncate rounded-[3px] px-1 text-left text-[10.5px] leading-[13px] text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{ top, left: pct(item.start), maxWidth: `calc(${pct(room)} - 6px)` }}
                  >
                    {item.label || item.id}
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

function Shot({
  segment,
  name,
  active,
  left,
  width,
  pixels,
  onKeyDown,
}: {
  segment: ResolvedSegment;
  name: string;
  active: boolean;
  left: string;
  width: string;
  /** The block's width, so a narrow shot drops its length instead of cutting it off. */
  pixels: number;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const picture = segment.src.kind === 'take' || segment.src.kind === 'file';
  const source = segment.src.kind === 'take' ? segment.src.name : segment.src.kind === 'color' ? segment.src.ref : null;
  return (
    <Tip
      label={
        <TipBody
          title={<><span className="mr-1.5 font-mono font-normal opacity-70">{segment.id}</span>{segment.label}</>}
          body={source ? `${source} from ${tenths(segment.in)} s${segment.hold > 0 ? `, holds ${secondsLabel(segment.hold)}` : ''}` : undefined}
          times={span(segment.start, segment.end)}
        />
      }
    >
      <button
        type="button"
        onKeyDown={onKeyDown}
        aria-label={`Shot ${segment.id}, ${segment.label}. ${tenths(segment.start)} to ${tenths(segment.end)} seconds.`}
        className="absolute top-0 flex h-full flex-col overflow-hidden pt-[6px] text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ left, width }}
      >
        <span
          className="relative block h-[32px] w-full flex-none overflow-hidden bg-foreground/[0.06]"
          style={segment.src.kind === 'color' ? { background: segment.src.color } : undefined}
        >
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local dev thumbnail, not an optimisable asset
            <img
              src={`/api/dev/cuts/${encodeURIComponent(name)}/thumbs/${encodeURIComponent(segment.id)}`}
              alt=""
              draggable={false}
              onLoad={() => setLoaded(true)}
              className={cn('h-full w-full object-cover transition-opacity duration-300', loaded ? 'opacity-100' : 'opacity-0')}
            />
          ) : null}
          {/* Drawn over the picture: a hairline where one shot meets the next, or the playhead colour round the current one. */}
          <span
            aria-hidden
            className={cn('pointer-events-none absolute inset-0', active ? 'shadow-[inset_0_0_0_1px_var(--cut-now)]' : 'shadow-[inset_1px_0_0_rgba(0,0,0,0.65)]')}
          />
        </span>
        <span className="mt-[5px] block truncate pr-1 pl-[3px] text-[11.5px] leading-[14px]">
          <span className={cn('mr-1 font-mono text-[10.5px]', active ? 'text-[var(--cut-now)]' : 'text-ink-muted')}>{segment.id}</span>
          <span className={active ? 'text-foreground' : 'text-foreground/[0.78]'}>{segment.label}</span>
        </span>
        <span className="block truncate pr-1 pl-[3px] font-mono text-[10px] leading-[12px] text-ink-faint tabular-nums">
          {tenths(segment.start)}{pixels >= 72 ? ` · ${secondsLabel(segment.end - segment.start)}` : ''}
        </span>
      </button>
    </Tip>
  );
}

/** Shown instead of the viewer when the cut file doesn't resolve. */
export function CutProblems({ name, message, errors }: { name: string; message: string; errors: CutError[] }) {
  return (
    <WorkbenchPanel className="dark" title={`${name}.cut.json`} icon={<Film size={13} strokeWidth={2} />} bodyClassName="p-6">
      <div className="grid max-w-[60ch] gap-4">
        <p className="text-[15px] text-foreground">{message}</p>
        <ul className="grid gap-2">
          {errors.map((error, i) => (
            <li key={i} className="rounded-md border border-border bg-surface-inset px-3 py-2 text-[13px]">
              <span className="mr-2 font-mono text-[11.5px] text-ink-muted">{error.code}{error.id ? ` · ${error.id}` : ''}{error.field ? `.${error.field}` : ''}</span>
              {error.message}
            </li>
          ))}
        </ul>
      </div>
    </WorkbenchPanel>
  );
}
