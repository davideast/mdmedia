import { describe, expect, it } from 'bun:test';
import { clearSubscriptionPool, multicastSubscribe } from '../../studio/src/lib/subscription-pool.js';

describe('Insight c9ad8fd0: Orphaned Firestore listeners during StrictMode navigation', () => {
  it('retains active Firestore listener during StrictMode double-mount with stable callback', async () => {
    clearSubscriptionPool();
    let firestoreDetached = false;

    const mockStart = () => {
      return () => {
        firestoreDetached = true;
      };
    };

    const stableCallback = () => {};

    const unsub1 = multicastSubscribe('strict-oracle-key', mockStart, stableCallback, 30);
    const unsub2 = multicastSubscribe('strict-oracle-key', mockStart, stableCallback, 30);

    unsub1();
    await new Promise((r) => setTimeout(r, 60));

    expect(firestoreDetached).toBe(false);

    unsub2();
    await new Promise((r) => setTimeout(r, 60));
    expect(firestoreDetached).toBe(true);
  });
});
