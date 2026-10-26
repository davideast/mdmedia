'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ProductionCutResource } from './productions';
import type { MediaLink } from './use-media-links';

/** Decode source frames independently of the review player, at each placement's source in-point. */
export function useAssemblyThumbnails(cut: ProductionCutResource | null, links: Record<string, MediaLink>) {
  const requests = useMemo(() => cut?.kind === 'assembly' ? (cut.timeline?.segments ?? []).flatMap(segment => {
    if (cut.thumbs[segment.id] || segment.src.kind !== 'asset') return [];
    const asset = cut.assets[segment.src.id];
    const link = links[segment.src.id];
    return asset && link ? [{ id: segment.id, key: `${segment.src.id}:${segment.in}`, url: link.content, time: segment.in, image: asset.mimeType.startsWith('image/') }] : [];
  }) : [], [cut, links]);
  const [frames, setFrames] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    const decoded = new Map<string, string>();
    void (async () => {
      // One decoder at a time keeps long timelines from opening dozens of videos at once.
      for (const request of requests) {
        if (controller.signal.aborted) break;
        try {
          const frame = request.image ? request.url : decoded.get(request.key) ?? await sourceFrame(request.url, request.time, controller.signal);
          decoded.set(request.key, frame);
          if (!controller.signal.aborted) setFrames(previous => ({ ...previous, [request.key]: frame }));
        } catch { /* An unavailable source must not prevent other clips or playback from loading. */ }
      }
    })();
    return () => controller.abort();
  }, [requests]);
  return useMemo(() => Object.fromEntries(requests.flatMap(r => frames[r.key] ? [[r.id, frames[r.key]]] : [])), [requests, frames]);
}

function sourceFrame(url: string, time: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    const finish = (frame?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      if (frame) resolve(frame); else reject(new Error('Source frame unavailable'));
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 15000);
    const capture = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(320, video.videoWidth);
        canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
        const context = canvas.getContext('2d');
        if (!context || !video.videoWidth) return finish();
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.75));
      } catch { finish(); }
    };
    video.onloadeddata = () => {
      video.onloadeddata = null;
      if (time > 0) { video.onseeked = capture; video.currentTime = time; }
      else capture();
    };
    video.onerror = abort;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    video.src = url;
  });
}
