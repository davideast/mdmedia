'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { studioJson } from './media-client';

/**
 * Signed links for private media, so `<video>` and `<img>` can load it
 * straight from Studio with byte ranges and the browser's cache, instead of
 * fetching whole files into blobs.
 *
 * Links come from `POST /api/v1/assets/links` and live 15 to 20 minutes.
 * They are kept per asset for the whole tab, so moving between pages reuses
 * them, and fetched again three minutes before they expire. A player keeps the
 * link it's playing until it pauses (see `useSteadySource`).
 */

export interface MediaLink {
  content: string;
  thumbnail: string | null;
  expiresAt: number;
}

/** Fresh enough to hand out: a page may hold it a while before using it. */
const FRESH_FOR_MS = 3 * 60_000;
const BATCH = 100;

const cache = new Map<string, MediaLink>();

// Links are absolute in the API's configured origin; the browser asks the Studio host it is on.
const localPath = (url: string) => { const parsed = new URL(url, window.location.origin); return `${parsed.pathname}${parsed.search}`; };

async function fetchLinks(ids: string[], signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const answer = await studioJson<{ links: Record<string, { content: string; thumbnail: string | null }>; expiresAt: number }>('/api/v1/assets/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(i, i + BATCH) }), signal,
    });
    for (const [id, link] of Object.entries(answer.links)) {
      cache.set(id, { content: localPath(link.content), thumbnail: link.thumbnail ? localPath(link.thumbnail) : null, expiresAt: answer.expiresAt });
    }
  }
}

const fresh = (id: string, now = Date.now()) => { const link = cache.get(id); return link && link.expiresAt - now > FRESH_FOR_MS ? link : undefined; };

/**
 * Links for these asset ids, by id. Ids without a link yet are missing from
 * the map. `refresh` fetches new links now, for a player whose link stopped
 * working.
 */
export function useMediaLinks(ids: readonly (string | null | undefined)[]): { links: Record<string, MediaLink>; error: string; refresh: () => Promise<void> } {
  const key = useMemo(() => [...new Set(ids.filter((id): id is string => Boolean(id)))].sort().join(','), [ids]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const wanted = key ? key.split(',') : [];
    if (!wanted.length) return;
    try { await fetchLinks(wanted); setError(''); } catch (e) { setError((e as Error).message); }
    setVersion((value) => value + 1);
  }, [key]);

  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    if (!wanted.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const missing = wanted.filter((id) => !fresh(id));
      if (missing.length) {
        try { await fetchLinks(missing, controller.signal); setError(''); } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
        if (controller.signal.aborted) return;
        setVersion((value) => value + 1);
      }
      const soonest = Math.min(...wanted.map((id) => cache.get(id)?.expiresAt ?? Infinity));
      // Try again in a minute after a failure; otherwise just before the soonest link runs out.
      const wait = Number.isFinite(soonest) ? Math.max(30_000, soonest - Date.now() - FRESH_FOR_MS + 1000) : 60_000;
      timer = setTimeout(() => void load(), wait);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);

  const links = useMemo(() => {
    void version;
    const map: Record<string, MediaLink> = {};
    for (const id of key ? key.split(',') : []) { const link = cache.get(id); if (link) map[id] = link; }
    return map;
  }, [key, version]);
  return { links, error, refresh };
}

const assetPath = (url: string) => url.split('?')[0];

type Resume = { time: number; play: boolean };

/** Points the player at `url`; once it has loaded, puts it back at `resume`. */
function load(element: HTMLVideoElement, url: string, resume: Resume | null) {
  if (resume) {
    element.addEventListener('loadedmetadata', () => {
      if (resume.time > 0) element.currentTime = resume.time;
      if (resume.play) void element.play().catch(() => {});
    }, { once: true });
  }
  element.src = url;
}

/**
 * Keeps a player's source on a link that is refreshed under it. The page
 * renders the `<video>` without a `src`; this sets it. A new link to the same
 * asset waits until the player is paused, then takes over where it stood,
 * so playback is never cut off; a link to another asset takes over at once.
 * If the player's link stops working (it expired while playing), call
 * `recover`: it fetches new links and carries on from the same time.
 */
export function useSteadySource(video: RefObject<HTMLVideoElement | null>, url: string | undefined, refresh: () => Promise<void>): { recover: () => void } {
  const recovering = useRef<Resume | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = video.current;
    if (!element || !url) return;
    const resume = recovering.current;
    if (resume) {
      // A recovery reloads even when the link came back the same.
      recovering.current = null;
      load(element, url, resume);
      return;
    }
    const current = element.getAttribute('src');
    if (current === url) return;
    if (!current || assetPath(current) !== assetPath(url)) { load(element, url, null); return; }
    const swap = () => load(element, url, { time: element.currentTime, play: false });
    if (element.paused) { swap(); return; }
    element.addEventListener('pause', swap, { once: true });
    return () => element.removeEventListener('pause', swap);
  }, [video, url, attempt]);

  // Where the player last stood while its link worked: a failed load resets the element, so read it from here.
  const lastGood = useRef<Resume>({ time: 0, play: false });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const note = () => { if (!element.error && element.readyState > 0) lastGood.current = { time: element.currentTime, play: !element.paused }; };
    const events = ['timeupdate', 'seeked', 'play', 'pause'] as const;
    for (const event of events) element.addEventListener(event, note);
    return () => { for (const event of events) element.removeEventListener(event, note); };
    // The player mounts once its link is known, so look for it again when the link arrives.
  }, [video, url]);

  const recover = () => {
    const element = video.current;
    if (recovering.current || !element) return;
    recovering.current = { ...lastGood.current };
    void refresh().finally(() => setAttempt((value) => value + 1));
  };
  return { recover };
}
