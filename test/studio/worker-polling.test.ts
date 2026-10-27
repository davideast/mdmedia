import { describe, expect, test } from 'bun:test';
import { startAdaptivePolling } from '../../studio/src/lib/worker-polling';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeWorker() {
  return { timer: null as ReturnType<typeof setTimeout> | null, running: new Set<string>() };
}

describe('startAdaptivePolling', () => {
  test('backs off to the idle interval once nothing is running', async () => {
    const worker = fakeWorker();
    let ticks = 0;
    startAdaptivePolling(worker, async () => { ticks += 1; }, { activeMs: 10, idleMs: 1000 });
    await wait(120);
    clearTimeout(worker.timer!);
    expect(ticks).toBe(1);
  });

  test('keeps the active interval while a job is running', async () => {
    const worker = fakeWorker();
    worker.running.add('job');
    let ticks = 0;
    startAdaptivePolling(worker, async () => { ticks += 1; }, { activeMs: 10, idleMs: 1000 });
    await wait(120);
    clearTimeout(worker.timer!);
    expect(ticks).toBeGreaterThan(4);
  });

  test('returns to idle after the last job finishes', async () => {
    const worker = fakeWorker();
    worker.running.add('job');
    let ticks = 0;
    startAdaptivePolling(worker, async () => { ticks += 1; if (ticks === 3) worker.running.clear(); }, { activeMs: 10, idleMs: 1000 });
    await wait(150);
    clearTimeout(worker.timer!);
    expect(ticks).toBe(3);
  });

  test('keeps polling after a failed tick and does not start twice', async () => {
    const worker = fakeWorker();
    worker.running.add('job');
    let ticks = 0;
    const tick = async () => { ticks += 1; throw new Error('database unavailable'); };
    startAdaptivePolling(worker, tick, { activeMs: 10, idleMs: 1000 });
    startAdaptivePolling(worker, tick, { activeMs: 10, idleMs: 1000 });
    await wait(80);
    clearTimeout(worker.timer!);
    expect(ticks).toBeGreaterThan(2);
    expect(ticks).toBeLessThan(10);
  });
});
