/**
 * Re-run a one-shot Firestore read that failed because the hosted sandbox
 * connection dropped. Pyric rejects every in-flight request with `unavailable`
 * when its WebSocket is interrupted, then reconnects and resumes the session on
 * its own, so a short backoff is usually enough. Only use this for reads, which
 * are safe to repeat; a dropped write may have completed. Other errors, and the
 * last `unavailable`, are thrown unchanged.
 */
export async function retryUnavailable<T>(
  read: () => Promise<T>,
  { retries = 3, delayMs = 400 }: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const unavailable = (error as { code?: string } | null)?.code === 'unavailable';
      if (!unavailable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}
