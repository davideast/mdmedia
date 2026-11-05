'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Status = 'online' | 'offline' | 'checking';
const ConnectivityContext = createContext<Status>('checking');

/** How many health checks in a row must fail before Studio counts as offline. */
export const OFFLINE_AFTER_FAILURES = 3;
const CHECK_EVERY_MS = 12_000;
const CHECK_TIMEOUT_MS = 4_000;
/** After a failed check, the next one comes this soon instead of waiting the full interval. */
const RECHECK_AFTER_FAILURE_MS = 1_000;

export interface ConnectivityState {
  status: Status;
  /** Failed health checks in a row since the last good one. */
  failures: number;
}

export type ConnectivityEvent =
  | { type: 'check-succeeded' }
  | { type: 'check-failed' }
  | { type: 'browser-offline' };

export const INITIAL_CONNECTIVITY: ConnectivityState = { status: 'checking', failures: 0 };

/**
 * One slow or failed health check doesn't make Studio offline: the machine
 * serving it is often busy rendering. Only OFFLINE_AFTER_FAILURES failures in
 * a row do. One good check brings it back. The browser saying it has no
 * network at all is believed at once.
 */
export function nextConnectivity(state: ConnectivityState, event: ConnectivityEvent): ConnectivityState {
  switch (event.type) {
    case 'check-succeeded':
      return { status: 'online', failures: 0 };
    case 'browser-offline':
      return { status: 'offline', failures: Math.max(state.failures, OFFLINE_AFTER_FAILURES) };
    case 'check-failed': {
      const failures = state.failures + 1;
      return { status: failures >= OFFLINE_AFTER_FAILURES ? 'offline' : state.status, failures };
    }
  }
}

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let active = true;
    let state = INITIAL_CONNECTIVITY;
    let controller: AbortController | null = null;
    let recheck: number | undefined;
    // Only the latest check reports; one it replaced (aborted) is not a failure.
    let latest = 0;
    const report = (event: ConnectivityEvent) => {
      state = nextConnectivity(state, event);
      if (active) setStatus(state.status);
    };
    const check = async () => {
      window.clearTimeout(recheck);
      controller?.abort();
      controller = null;
      if (!navigator.onLine) { report({ type: 'browser-offline' }); return; }
      const run = ++latest;
      const current = new AbortController();
      controller = current;
      const timeout = window.setTimeout(() => current.abort(), CHECK_TIMEOUT_MS);
      let ok = false;
      try {
        const response = await fetch('/api/connectivity', {
          cache: 'no-store',
          signal: current.signal,
          headers: { 'x-mdmedia-health': '1' },
        });
        ok = response.ok;
      } catch {
        ok = false;
      } finally {
        window.clearTimeout(timeout);
      }
      if (!active || run !== latest) return;
      report({ type: ok ? 'check-succeeded' : 'check-failed' });
      if (!ok && state.status !== 'offline') recheck = window.setTimeout(() => void check(), RECHECK_AFTER_FAILURE_MS);
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const wentOnline = () => void check();
    const wentOffline = () => {
      latest += 1;
      controller?.abort();
      window.clearTimeout(recheck);
      report({ type: 'browser-offline' });
    };
    window.addEventListener('online', wentOnline);
    window.addEventListener('offline', wentOffline);
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(recheck);
      window.clearInterval(timer);
      window.removeEventListener('online', wentOnline);
      window.removeEventListener('offline', wentOffline);
    };
  }, []);

  return <ConnectivityContext.Provider value={status}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): Status {
  return useContext(ConnectivityContext);
}
