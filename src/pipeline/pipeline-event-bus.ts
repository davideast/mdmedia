import type { PipelineEventMap } from '../types/events.js';

/**
 * Listeners may be synchronous or return a promise. Promises are only awaited by
 * `emitAndWait`; plain `emit` stays fire-and-forget for hot-path events.
 */
type Listener<T> = (data: T) => void | Promise<void>;

export class UniversalEventBus {
  private readonly listeners = new Map<keyof PipelineEventMap, Set<Listener<any>>>();

  on<K extends keyof PipelineEventMap>(event: K, listener: Listener<PipelineEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof PipelineEventMap>(event: K, listener: Listener<PipelineEventMap[K]>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
    }
  }

  /**
   * Fire-and-forget dispatch. Any promise a listener returns is NOT awaited, so
   * use `emitAndWait` for lifecycle events where the caller must observe the
   * listener's completed side effects (e.g. a file being fully flushed to disk).
   */
  emit<K extends keyof PipelineEventMap>(event: K, data: PipelineEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      // Snapshot: a listener may unsubscribe itself or others during dispatch.
      for (const listener of [...set]) {
        const result = listener(data);
        if (result instanceof Promise) {
          // Fire-and-forget, but never let it surface as an unhandled rejection.
          result.catch((err) => {
            console.error(`[UniversalEventBus] Unhandled rejection in '${String(event)}' listener:`, err);
          });
        }
      }
    }
  }

  /**
   * Dispatch and await every listener that returns a promise. Listeners run
   * concurrently, not serially, and a rejection from any one of them propagates
   * after all have settled, so one failing sink cannot strand the others.
   */
  async emitAndWait<K extends keyof PipelineEventMap>(
    event: K,
    data: PipelineEventMap[K]
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    const pending: Promise<void>[] = [];
    for (const listener of [...set]) {
      const result = listener(data);
      if (result instanceof Promise) {
        pending.push(result);
      }
    }
    if (pending.length === 0) return;

    const settled = await Promise.allSettled(pending);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
    }
  }
}
