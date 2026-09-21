import type { Unsubscribe } from "firebase/firestore";

interface PoolEntry<T> {
  subscribers: Set<(data: T) => void>;
  latestData: T | undefined;
  hasData: boolean;
  unsubscribeFirestore: Unsubscribe | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, PoolEntry<any>>();

/**
 * Multicast a single Firestore onSnapshot listener across multiple subscribers
 * by key.
 *
 * Benefits:
 * 1. Eliminates duplicate subscriptions when multiple components or hooks
 *    listen to the same document or query (e.g. Player, Inspector, Page).
 * 2. Provides instant cached delivery for new subscribers.
 * 3. Incorporates a grace period before detaching from Firestore, which eliminates
 *    listener churn across React StrictMode mount/cleanup cycles and rapid navigation.
 */
export function multicastSubscribe<T>(
  key: string,
  startFirestore: (
    onData: (data: T) => void,
    onError?: (err: unknown) => void,
  ) => Unsubscribe,
  callback: (data: T) => void,
  gracePeriodMs = 200,
): Unsubscribe {
  let entry = pool.get(key) as PoolEntry<T> | undefined;

  if (!entry) {
    entry = {
      subscribers: new Set(),
      latestData: undefined,
      hasData: false,
      unsubscribeFirestore: null,
      cleanupTimer: null,
    };
    pool.set(key, entry);

    const activeEntry = entry;
    activeEntry.unsubscribeFirestore = startFirestore(
      (data: T) => {
        if (!pool.has(key)) return;
        activeEntry.latestData = data;
        activeEntry.hasData = true;
        for (const sub of activeEntry.subscribers) {
          try {
            sub(data);
          } catch (err) {
            console.error(`[subscription-pool] Error in subscriber callback for ${key}:`, err);
          }
        }
      },
      (err) => {
        console.error(`[subscription-pool] Firestore error on ${key}:`, err);
      },
    );
  } else if (entry.cleanupTimer !== null) {
    // Cancel scheduled detachment since a new subscriber attached during grace period
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }

  entry.subscribers.add(callback);

  // Deliver current cached snapshot immediately if available
  if (entry.hasData && entry.latestData !== undefined) {
    try {
      callback(entry.latestData);
    } catch (err) {
      console.error(`[subscription-pool] Error delivering cached snapshot for ${key}:`, err);
    }
  }

  return () => {
    const currentEntry = pool.get(key) as PoolEntry<T> | undefined;
    if (!currentEntry) return;

    currentEntry.subscribers.delete(callback);

    if (currentEntry.subscribers.size === 0) {
      if (currentEntry.cleanupTimer !== null) {
        clearTimeout(currentEntry.cleanupTimer);
      }
      currentEntry.cleanupTimer = setTimeout(() => {
        const checkEntry = pool.get(key);
        if (checkEntry && checkEntry.subscribers.size === 0) {
          try {
            checkEntry.unsubscribeFirestore?.();
          } catch (err) {
            console.error(`[subscription-pool] Error tearing down Firestore listener for ${key}:`, err);
          }
          pool.delete(key);
        }
      }, gracePeriodMs);
    }
  };
}

/** Clear all active pools (useful for tests or hard resets). */
export function clearSubscriptionPool(): void {
  for (const [key, entry] of pool.entries()) {
    if (entry.cleanupTimer !== null) {
      clearTimeout(entry.cleanupTimer);
    }
    try {
      entry.unsubscribeFirestore?.();
    } catch {
      // ignore
    }
  }
  pool.clear();
}
