'use client';

import { useCallback, useEffect, useState } from 'react';
import { studioJson } from './media-client';

/**
 * Reads one Studio API resource and keeps the last answer for the tab, so
 * coming back to a page shows it at once while a fresh copy loads.
 * `update` replaces it (after a change the page made), here and in the cache.
 */

const cache = new Map<string, unknown>();

export function useStudioResource<T>(path: string | null): { data: T | null; error: string; reload: () => void; update: (next: T) => void } {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string }>(() => ({ path, data: path ? (cache.get(path) as T | undefined) ?? null : null, error: '' }));
  const [attempt, setAttempt] = useState(0);
  const current = state.path === path ? state : { path, data: path ? (cache.get(path) as T | undefined) ?? null : null, error: '' };

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    studioJson<T>(path, { signal: controller.signal })
      .then((data) => { cache.set(path, data); setState({ path, data, error: '' }); })
      .catch((e: Error) => { if (!controller.signal.aborted) setState((previous) => ({ path, data: previous.path === path ? previous.data : null, error: e.message })); });
    return () => controller.abort();
  }, [path, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const update = useCallback((next: T) => { if (path) cache.set(path, next); setState({ path, data: next, error: '' }); }, [path]);
  return { data: current.data, error: current.error, reload, update };
}

/** Replaces a cached resource from elsewhere, such as a production changed on its own page. */
export function primeStudioResource(path: string, data: unknown): void {
  cache.set(path, data);
}
