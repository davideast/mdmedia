'use client';
import { useEffect, useRef, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { studioFetch } from '@/lib/media-client';
export function AssetImage({ id, thumbnail = false, alt, className = '' }: { id: string; thumbnail?: boolean; alt: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState({ key: '', source: '' });
  const [failedKey, setFailedKey] = useState('');
  const key = `${id}:${thumbnail}`;
  const source = loaded.key === key ? loaded.source : '';
  const failed = failedKey === key;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '150px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(); let objectUrl = '';
    void studioFetch(`/api/v1/assets/${encodeURIComponent(id)}/content${thumbnail ? '?thumbnail=1' : ''}`, { signal: controller.signal })
      .then(response => response.blob()).then(blob => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setLoaded({ key: `${id}:${thumbnail}`, source: objectUrl });
      }).catch(() => { if (!controller.signal.aborted) setFailedKey(`${id}:${thumbnail}`); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, thumbnail, visible]);
  return <div ref={ref} className={`flex items-center justify-center overflow-hidden bg-muted/30 ${className}`}>
    {/* Authorized blob URLs are decoded locally; Next image optimization cannot fetch these private assets. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {source ? <img src={source} alt={alt} className="h-full w-full object-contain" /> : <span className="flex items-center gap-2 p-3 text-xs text-ink-muted"><ImageIcon size={18} />{failed ? 'Preview unavailable' : 'Loading image…'}</span>}
  </div>;
}
export async function downloadAsset(id: string, filename: string) {
  const response = await studioFetch(`/api/v1/assets/${id}/content?download=1`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
