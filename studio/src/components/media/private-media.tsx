'use client';
import { useEffect, useState } from 'react';
import { studioFetch } from '@/lib/media-client';

// API links use the configured public origin; browser fetches stay on the current Studio host.
const localPath = (path: string) => { const url = new URL(path, window.location.origin); return `${url.pathname}${url.search}`; };

/** Private media uses an authenticated request and a revocable local URL, never a public storage URL. */
export function usePrivateMedia(path: string | null) {
  const [loaded, setLoaded] = useState({ path: '', url: '', error: '' });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); let url = '';
    void studioFetch(localPath(path), { signal: controller.signal }).then(response => response.blob()).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setLoaded({ path, url, error: '' });
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ path, url: '', error: 'Preview unavailable.' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return loaded.path === path ? loaded : { url: '', error: '' };
}
export function PrivateThumbnail({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const { url } = usePrivateMedia(path);
  // The authorized blob is decoded locally; Next optimization cannot authenticate this private request.
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} className={className} /> : <div aria-label={alt} className={`animate-pulse bg-muted ${className}`} />;
}
export async function downloadPrivateMedia(path: string, filename: string) {
  const url = URL.createObjectURL(await (await studioFetch(localPath(path))).blob());
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
