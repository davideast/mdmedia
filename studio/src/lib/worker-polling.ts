export const ACTIVE_POLL_MS = 5000;
export const IDLE_POLL_MS = 60_000;

type PollingWorker = { timer: ReturnType<typeof setTimeout> | null; running: Set<string> };

/**
 * Polls a media job queue without hammering the database while it is empty.
 * Jobs enqueued in this process run immediately, so polling exists to recover
 * stale leases after a restart and to pick up work another instance left
 * behind. The first poll comes after `activeMs`, which covers that restart
 * scan; later polls come every `idleMs` until a job is running, then every
 * `activeMs` until the worker is idle again.
 */
export function startAdaptivePolling(
  worker: PollingWorker,
  tick: () => Promise<void>,
  { activeMs = ACTIVE_POLL_MS, idleMs = IDLE_POLL_MS }: { activeMs?: number; idleMs?: number } = {},
) {
  if (worker.timer) return;
  let delay = activeMs;
  const schedule = () => {
    worker.timer = setTimeout(async () => {
      await tick().catch(() => {});
      delay = worker.running.size ? activeMs : idleMs;
      schedule();
    }, delay);
    worker.timer.unref();
  };
  schedule();
}
