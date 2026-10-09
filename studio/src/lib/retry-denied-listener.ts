import type { Unsubscribe } from "firebase/firestore";

/**
 * Keep a Firestore listener alive across a `permission-denied` caused by a
 * document that does not exist yet. Rules cannot read `resource.data` of a
 * missing document, so Firestore ends the listener; re-attach a bounded number
 * of times while `shouldRetry` holds, then report the error. Other errors are
 * reported immediately.
 */
export function retryDeniedListener(
  attach: (onError: (error: unknown) => void) => Unsubscribe,
  onGiveUp: (error: unknown) => void,
  { retries = 10, delayMs = 300, shouldRetry = () => true }: {
    retries?: number; delayMs?: number; shouldRetry?: () => boolean;
  } = {},
): Unsubscribe {
  let stopped = false;
  let detach: Unsubscribe | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = (retriesLeft: number) => {
    detach = attach((error) => {
      const denied = (error as { code?: string } | null)?.code === "permission-denied";
      if (denied && retriesLeft > 0 && !stopped && shouldRetry()) {
        timer = setTimeout(() => start(retriesLeft - 1), delayMs);
        return;
      }
      onGiveUp(error);
    });
  };
  start(retries);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    detach?.();
  };
}
