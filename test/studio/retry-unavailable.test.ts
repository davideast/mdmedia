import { describe, expect, it } from 'bun:test';
import { retryUnavailable } from '../../studio/src/lib/retry-unavailable';

const unavailable = { code: 'unavailable' };

describe('retryUnavailable', () => {
  it('returns the result without retrying when the read succeeds', async () => {
    let calls = 0;
    const result = await retryUnavailable(async () => { calls++; return 'ok'; }, { delayMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries after the connection drops and returns the later result', async () => {
    let calls = 0;
    const result = await retryUnavailable(async () => {
      calls++;
      if (calls < 3) throw unavailable;
      return 'ok';
    }, { delayMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws the last unavailable error once retries are exhausted', async () => {
    let calls = 0;
    const read = () => retryUnavailable(async () => { calls++; throw unavailable; }, { retries: 2, delayMs: 1 });
    await expect(read()).rejects.toBe(unavailable);
    expect(calls).toBe(3);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    const denied = { code: 'permission-denied' };
    const read = () => retryUnavailable(async () => { calls++; throw denied; }, { delayMs: 1 });
    await expect(read()).rejects.toBe(denied);
    expect(calls).toBe(1);
  });
});
