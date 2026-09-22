"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseReaderFollowOptions {
  /** Scrollable container holding the reader content */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Start character index of the active word in the transcript */
  activeCharStart: number | null;
  /** End character index of the active word in the transcript */
  activeCharEnd: number | null;
  /** Whether narration audio is currently playing */
  isPlaying: boolean;
  /** Disable follow logic (e.g. when viewing raw source instead of adapted text) */
  disabled?: boolean;
}

export interface UseReaderFollowResult {
  /** Whether the view is currently auto-scrolling to follow narration speech */
  isFollowing: boolean;
  /** Whether the floating 'Follow' button should be shown */
  showFollowButton: boolean;
  /** Smoothly scroll to the active word and resume follow mode */
  scrollToCurrent: () => void;
}

const BOTTOM_CLEARANCE_PX = 140;
const TOP_MARGIN_PX = 36;
const TARGET_VIEWPORT_FRACTION = 0.32;
const SCROLL_RESET_DELAY_MS = 550;

/**
 * Hook managing narration "Follow" mode in the Reader view.
 *
 * - When playback starts, Follow mode is automatically activated.
 * - In Follow mode, as the spoken word highlight advances near the lower viewport
 *   horizon (above the floating player bar), the page scrolls down smoothly.
 * - When the user scrolls manually, Follow mode disengages and a floating 'Follow'
 *   button appears above the player dock.
 * - Pressing 'Follow' scrolls back to the current spoken word and resumes follow mode.
 */
export function useReaderFollow({
  containerRef,
  activeCharStart,
  activeCharEnd,
  isPlaying,
  disabled = false,
}: UseReaderFollowOptions): UseReaderFollowResult {
  const [isFollowing, setIsFollowing] = useState(isPlaying);
  const wasPlayingRef = useRef(isPlaying);
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerProgrammaticScroll = useCallback(
    (targetTop: number) => {
      const container = containerRef.current;
      if (!container) return;

      isProgrammaticScrollRef.current = true;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });

      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
      programmaticScrollTimerRef.current = setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, SCROLL_RESET_DELAY_MS);
    },
    [containerRef],
  );

  const scrollToCurrent = useCallback(() => {
    setIsFollowing(true);
    const container = containerRef.current;
    if (!container) return;

    const activeEl = container.querySelector<HTMLElement>('[data-word-active="true"]');
    if (!activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const wordRect = activeEl.getBoundingClientRect();
    const targetTop =
      container.scrollTop +
      (wordRect.top - containerRect.top) -
      container.clientHeight * TARGET_VIEWPORT_FRACTION;

    triggerProgrammaticScroll(targetTop);
  }, [containerRef, triggerProgrammaticScroll]);

  // When playback starts (transition from paused to playing), activate Follow mode
  useEffect(() => {
    if (disabled) return;

    if (isPlaying && !wasPlayingRef.current) {
      setIsFollowing(true);
      // Ensure we immediately scroll to the active word when starting playback
      requestAnimationFrame(() => {
        scrollToCurrent();
      });
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying, disabled, scrollToCurrent]);

  // Listen to user interactions on the scroll container to disengage Follow mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) return;

    const handleUserScroll = () => {
      if (isProgrammaticScrollRef.current) return;
      setIsFollowing(false);
    };

    const handleKeyScroll = (event: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
      if (keys.includes(event.key)) {
        setIsFollowing(false);
      }
    };

    container.addEventListener("wheel", handleUserScroll, { passive: true });
    container.addEventListener("touchmove", handleUserScroll, { passive: true });
    container.addEventListener("pointerdown", handleUserScroll, { passive: true });
    container.addEventListener("scroll", handleUserScroll, { passive: true });
    window.addEventListener("keydown", handleKeyScroll);

    return () => {
      container.removeEventListener("wheel", handleUserScroll);
      container.removeEventListener("touchmove", handleUserScroll);
      container.removeEventListener("pointerdown", handleUserScroll);
      container.removeEventListener("scroll", handleUserScroll);
      window.removeEventListener("keydown", handleKeyScroll);
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, [containerRef, disabled]);

  // Auto-scroll when the active word moves out of comfortable reading bounds in Follow mode
  useEffect(() => {
    if (!isFollowing || disabled || activeCharStart === null) return;

    const container = containerRef.current;
    if (!container) return;

    const activeEl = container.querySelector<HTMLElement>('[data-word-active="true"]');
    if (!activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const wordRect = activeEl.getBoundingClientRect();

    const isBelowHorizon = wordRect.bottom > containerRect.bottom - BOTTOM_CLEARANCE_PX;
    const isAboveHorizon = wordRect.top < containerRect.top + TOP_MARGIN_PX;

    if (isBelowHorizon || isAboveHorizon) {
      const targetTop =
        container.scrollTop +
        (wordRect.top - containerRect.top) -
        container.clientHeight * TARGET_VIEWPORT_FRACTION;

      triggerProgrammaticScroll(targetTop);
    }
  }, [activeCharStart, activeCharEnd, isFollowing, disabled, containerRef, triggerProgrammaticScroll]);

  // Floating follow button is shown whenever follow mode is off and an active word exists
  const showFollowButton = !isFollowing && !disabled && activeCharStart !== null;

  return {
    isFollowing,
    showFollowButton,
    scrollToCurrent,
  };
}
