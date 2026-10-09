/**
 * A sliding-window limiter held in process memory. The studio runs as one
 * long-lived server, so this bounds what a single key can start; it resets when
 * the server restarts, which only ever loosens it.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }) {
  const hits = new Map<string, number[]>();
  return {
    /** Records a hit and returns how long to wait in ms, or 0 when the hit is allowed. */
    take(key: string): number {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((time) => at - time < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return windowMs - (at - recent[0]);
      }
      recent.push(at);
      hits.set(key, recent);
      return 0;
    },
  };
}
