import { describe, expect, it } from 'bun:test';
import { retryDeniedListener } from '../../studio/src/lib/retry-denied-listener';

const denied = { code: 'permission-denied' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function harness(options: Parameters<typeof retryDeniedListener>[2] = { retries: 3, delayMs: 10 }) {
  const errorHandlers: Array<(error: unknown) => void> = [];
  let detached = 0;
  const gaveUp: unknown[] = [];
  const stop = retryDeniedListener(
    onError => { errorHandlers.push(onError); return () => { detached++; }; },
    error => gaveUp.push(error),
    options,
  );
  return { errorHandlers, gaveUp, stop, detached: () => detached };
}

describe('listener attached before the server creates the document', () => {
  it('re-attaches after permission-denied instead of leaving a dead listener', async () => {
    const h = harness();
    h.errorHandlers[0](denied);
    await wait(30);
    expect(h.errorHandlers).toHaveLength(2);
    expect(h.gaveUp).toHaveLength(0);
    h.stop();
  });

  it('reports the error once retries are exhausted', async () => {
    const h = harness({ retries: 2, delayMs: 5 });
    for (let i = 0; i < 3; i++) { h.errorHandlers[i](denied); await wait(20); }
    expect(h.errorHandlers).toHaveLength(3);
    expect(h.gaveUp).toEqual([denied]);
  });

  it('does not retry other errors', async () => {
    const h = harness();
    h.errorHandlers[0]({ code: 'unavailable' });
    await wait(30);
    expect(h.errorHandlers).toHaveLength(1);
    expect(h.gaveUp).toHaveLength(1);
    h.stop();
  });

  it('stops retrying once unsubscribed', async () => {
    const h = harness();
    h.errorHandlers[0](denied);
    h.stop();
    await wait(30);
    expect(h.errorHandlers).toHaveLength(1);
    expect(h.detached()).toBe(1);
  });

  it('reports a denial at once when the document is not awaiting creation', async () => {
    const h = harness({ retries: 3, delayMs: 5, shouldRetry: () => false });
    h.errorHandlers[0](denied);
    await wait(20);
    expect(h.errorHandlers).toHaveLength(1);
    expect(h.gaveUp).toEqual([denied]);
  });

  it('stops retrying once the creation window closes', async () => {
    let awaiting = true;
    const h = harness({ retries: 5, delayMs: 5, shouldRetry: () => awaiting });
    h.errorHandlers[0](denied);
    await wait(20);
    awaiting = false;
    h.errorHandlers[1](denied);
    await wait(20);
    expect(h.errorHandlers).toHaveLength(2);
    expect(h.gaveUp).toEqual([denied]);
  });
});
