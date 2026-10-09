import { describe, expect, it } from 'bun:test';
import { retryDeniedListener } from '../../studio/src/lib/retry-denied-listener';

const denied = { code: 'permission-denied' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = { retries: 3, delayMs: 10 }) {
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
});
