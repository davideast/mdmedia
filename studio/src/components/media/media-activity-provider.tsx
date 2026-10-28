'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { STUDIO_MUTATION_EVENT, studioJson } from '@/lib/media-client';
import { useConnectivity } from '@/lib/connectivity';
const MediaActivityContext = createContext(0);
export function MediaActivityProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const connectivity = useConnectivity();
  useEffect(() => {
    if (connectivity === 'offline') return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    // Count on load, on focus and after a Studio change; poll only while something is generating.
    const load = async () => {
      clearTimeout(timer);
      let active = 0;
      try {
        const pages = await Promise.all(['image', 'video', 'music', 'sfx'].flatMap(type => ['queued', 'generating'].map(status => studioJson<{ items: unknown[] }>(`/api/v1/generations?type=${type}&status=${status}`, { signal: controller.signal }))));
        active = pages.reduce((sum, page) => sum + page.items.length, 0);
        if (!controller.signal.aborted) setCount(active);
      } catch { /* Directory and editor show actionable errors; background counts do not interrupt work. */ }
      if (!controller.signal.aborted && active > 0) timer = setTimeout(load, 5000);
    };
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    void load();
    window.addEventListener(STUDIO_MUTATION_EVENT, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort(); clearTimeout(timer);
      window.removeEventListener(STUDIO_MUTATION_EVENT, refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [connectivity]);
  return <MediaActivityContext.Provider value={count}>{children}</MediaActivityContext.Provider>;
}
export const useActiveImageCount = () => useContext(MediaActivityContext);
