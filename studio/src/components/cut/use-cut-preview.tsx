'use client';

import { useEffect, useId, useRef, useState, type RefObject } from 'react';

const STORAGE_KEY = 'mdmedia.cut-preview-height';
const MIN_HEIGHT = 200;
const bounded = (height: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(window.innerHeight * 0.85, height)));

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Resize and fullscreen the existing stage, keeping its video and playback state mounted. */
export function useCutPreview(videoRef: RefObject<HTMLVideoElement | null>) {
  const stageRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [height, setHeight] = useState<number | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(MIN_HEIGHT);
  const [fullscreen, setFullscreen] = useState(false);
  const [fallback, setFallback] = useState(false);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);

  useEffect(() => {
    const restore = requestAnimationFrame(() => {
      try {
        const saved = Number(localStorage.getItem(STORAGE_KEY));
        if (saved > 0 && Number.isFinite(saved)) setHeight(bounded(saved));
      } catch { /* Storage can be disabled. Resizing still works. */ }
    });
    const resize = () => setHeight(value => value === null ? null : bounded(value));
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(restore); window.removeEventListener('resize', resize); };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setMeasuredHeight(Math.round(stage.getBoundingClientRect().height)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const remember = (value: number | null) => {
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* Optional preference. */ }
  };

  useEffect(() => {
    const video = videoRef.current;
    const sync = () => {
      const active = document.fullscreenElement === stageRef.current;
      setFullscreen(active);
      if (!active) buttonRef.current?.focus({ preventScroll: true });
    };
    const begin = () => setFullscreen(true);
    const end = () => { setFullscreen(false); buttonRef.current?.focus({ preventScroll: true }); };
    document.addEventListener('fullscreenchange', sync);
    video?.addEventListener('webkitbeginfullscreen', begin);
    video?.addEventListener('webkitendfullscreen', end);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      video?.removeEventListener('webkitbeginfullscreen', begin);
      video?.removeEventListener('webkitendfullscreen', end);
    };
  }, [videoRef]);

  useEffect(() => {
    if (!fallback) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setFallback(false); setFullscreen(false); buttonRef.current?.focus(); }
    };
    window.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', escape); };
  }, [fallback]);

  const toggleFullscreen = async () => {
    if (fallback) { setFallback(false); setFullscreen(false); return; }
    if (document.fullscreenElement === stageRef.current) { await document.exitFullscreen(); return; }
    const video = videoRef.current as FullscreenVideo | null;
    try {
      if (stageRef.current?.requestFullscreen) { await stageRef.current.requestFullscreen(); return; }
      if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    } catch { /* Embedded browsers can deny native fullscreen; expand in the page instead. */ }
    setFallback(true);
    setFullscreen(true);
  };

  const separator = (
    <div
      role="separator" aria-label="Resize video preview" aria-orientation="horizontal"
      aria-controls={id} aria-valuemin={MIN_HEIGHT} aria-valuenow={measuredHeight}
      tabIndex={0}
      title="Drag to resize preview. Arrow keys resize; double-click resets."
      className="group -my-3 flex h-6 flex-none cursor-row-resize touch-none select-none items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-ring"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointer: event.pointerId, y: event.clientY, height: stageRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) setHeight(bounded(start.height + event.clientY - start.y));
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (start?.pointer !== event.pointerId) return;
        const next = bounded(start.height + event.clientY - start.y);
        setHeight(next); remember(next); drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => { setHeight(null); remember(null); }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const current = height ?? stageRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
        const next = bounded(event.key === 'Home' ? MIN_HEIGHT : event.key === 'End' ? window.innerHeight : current + (event.key === 'ArrowDown' ? 24 : -24));
        setHeight(next); remember(next);
      }}
    >
      <span className="h-1 w-12 rounded-full bg-foreground/20 transition-colors group-hover:bg-foreground/50 group-focus-visible:bg-foreground/50" />
    </div>
  );
  return { stageRef, buttonRef, id, height, fullscreen, fallback, toggleFullscreen, separator };
}
