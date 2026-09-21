import { describe, expect, it } from 'bun:test';
import { clearSubscriptionPool, multicastSubscribe } from '../../studio/src/lib/subscription-pool';

describe('multicastSubscribe', () => {
  it('deduplicates listeners: calling twice with the same key attaches only 1 underlying Firestore listener', () => {
    clearSubscriptionPool();
    let attachCount = 0;
    let detachCount = 0;

    const mockStart = (onData: (val: string) => void) => {
      attachCount++;
      onData('initial');
      return () => {
        detachCount++;
      };
    };

    const received1: string[] = [];
    const received2: string[] = [];

    const unsub1 = multicastSubscribe('test-key-1', mockStart, (v) => received1.push(v), 50);
    const unsub2 = multicastSubscribe('test-key-1', mockStart, (v) => received2.push(v), 50);

    expect(attachCount).toBe(1);
    expect(received1).toEqual(['initial']);
    expect(received2).toEqual(['initial']);

    unsub1();
    expect(detachCount).toBe(0); // Still 1 active subscriber (unsub2)

    unsub2();
  });

  it('delivers subsequent updates to all active subscribers', () => {
    clearSubscriptionPool();
    let emitData: (val: string) => void = () => {};

    const mockStart = (onData: (val: string) => void) => {
      emitData = onData;
      return () => {};
    };

    const received1: string[] = [];
    const received2: string[] = [];

    multicastSubscribe('test-key-2', mockStart, (v) => received1.push(v), 50);
    multicastSubscribe('test-key-2', mockStart, (v) => received2.push(v), 50);

    emitData('update-1');
    emitData('update-2');

    expect(received1).toEqual(['update-1', 'update-2']);
    expect(received2).toEqual(['update-1', 'update-2']);
  });

  it('delivers cached snapshot immediately to late subscribers without re-querying', () => {
    clearSubscriptionPool();
    let emitData: (val: string) => void = () => {};

    const mockStart = (onData: (val: string) => void) => {
      emitData = onData;
      return () => {};
    };

    multicastSubscribe('test-key-3', mockStart, () => {}, 50);
    emitData('cached-state');

    const lateReceived: string[] = [];
    multicastSubscribe('test-key-3', mockStart, (v) => lateReceived.push(v), 50);

    expect(lateReceived).toEqual(['cached-state']);
  });

  it('cleans up underlying listener after all subscribers unsubscribe and grace period passes', async () => {
    clearSubscriptionPool();
    let detachCount = 0;

    const mockStart = () => {
      return () => {
        detachCount++;
      };
    };

    const unsub1 = multicastSubscribe('test-key-4', mockStart, () => {}, 20);
    expect(detachCount).toBe(0);

    unsub1();
    expect(detachCount).toBe(0); // In grace period

    await new Promise((r) => setTimeout(r, 40));
    expect(detachCount).toBe(1); // Detached after grace period
  });

  it('survives React StrictMode cycles (unsubscribe then immediately resubscribe within grace period)', async () => {
    clearSubscriptionPool();
    let attachCount = 0;
    let detachCount = 0;

    const mockStart = () => {
      attachCount++;
      return () => {
        detachCount++;
      };
    };

    // StrictMode mount 1
    const unsub1 = multicastSubscribe('strict-mode-key', mockStart, () => {}, 50);
    expect(attachCount).toBe(1);

    // StrictMode unmount 1
    unsub1();
    expect(detachCount).toBe(0);

    // StrictMode mount 2 (occurs immediately)
    const unsub2 = multicastSubscribe('strict-mode-key', mockStart, () => {}, 50);
    expect(attachCount).toBe(1); // Did not re-attach!

    await new Promise((r) => setTimeout(r, 80));
    expect(detachCount).toBe(0); // Grace period was aborted, listener remains alive

    unsub2();
    await new Promise((r) => setTimeout(r, 80));
    expect(detachCount).toBe(1); // Now detached cleanly
  });
});
