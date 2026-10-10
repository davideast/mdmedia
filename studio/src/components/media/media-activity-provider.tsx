'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { studioJson } from '@/lib/media-client';
import { useConnectivity } from '@/lib/connectivity';
const MediaActivityContext = createContext(0);
export function MediaActivityProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const connectivity = useConnectivity();
  useEffect(() => {
    if (connectivity === 'offline') return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const pages = await Promise.all(['queued', 'generating'].map(status => studioJson<{ items: unknown[] }>(`/api/v1/generations?type=image&status=${status}`, { signal: controller.signal })));
        if (!controller.signal.aborted) setCount(pages.reduce((sum, page) => sum + page.items.length, 0));
      } catch { /* Directory and editor show actionable errors; background counts do not interrupt work. */ }
      if (!controller.signal.aborted) timer = setTimeout(load, 5000);
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [connectivity]);
  return <MediaActivityContext.Provider value={count}>{children}</MediaActivityContext.Provider>;
}
export const useActiveImageCount = () => useContext(MediaActivityContext);
