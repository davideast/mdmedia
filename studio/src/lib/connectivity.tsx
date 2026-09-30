'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Status = 'online' | 'offline' | 'checking';
const ConnectivityContext = createContext<Status>('checking');

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const check = async () => {
      controller?.abort();
      if (!navigator.onLine) { setStatus('offline'); return; }
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 4000);
      try {
        const response = await fetch('/api/connectivity', {
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'x-mdmedia-health': '1' },
        });
        if (active) setStatus(response.ok ? 'online' : 'offline');
      } catch {
        if (active) setStatus('offline');
      } finally { window.clearTimeout(timeout); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 12000);
    window.addEventListener('online', check);
    const wentOffline = () => setStatus('offline');
    window.addEventListener('offline', wentOffline);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', wentOffline);
    };
  }, []);

  return <ConnectivityContext.Provider value={status}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): Status {
  return useContext(ConnectivityContext);
}
