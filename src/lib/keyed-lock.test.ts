import { describe, it, expect } from 'vitest';
import { runExclusive } from './keyed-lock.js';

/** A promise plus its resolve/reject handles, for hand-driving timing in tests. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runExclusive', () => {
  it('serializes calls with the same key (no overlap)', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const task = (i: number) =>
      runExclusive('k', async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        // Yield to the event loop so any overlapping task would be observed.
        await Promise.resolve();
        await Promise.resolve();
        order.push(i);
        active--;
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]); // FIFO arrival order
  });

  it('runs different keys concurrently', async () => {
    const a = deferred();
    const b = deferred();
    let aRunning = false;
    let bRunning = false;

    const pa = runExclusive('a', async () => {
      aRunning = true;
      await a.promise;
    });
    const pb = runExclusive('b', async () => {
      bRunning = true;
      await b.promise;
    });

    // Let both bodies start.
    await Promise.resolve();
    expect(aRunning).toBe(true);
    expect(bRunning).toBe(true);

    a.resolve();
    b.resolve();
    await Promise.all([pa, pb]);
  });

  it('returns the resolved value to the caller', async () => {
    await expect(runExclusive('v', async () => 42)).resolves.toBe(42);
  });

  it('propagates rejection to the caller without poisoning the queue', async () => {
    const failed = runExclusive('q', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    // A subsequent call on the same key must still run.
    await expect(runExclusive('q', async () => 'ok')).resolves.toBe('ok');
  });

  it('still serializes the next call even when the previous one rejects', async () => {
    const first = deferred();
    let secondStarted = false;

    const p1 = runExclusive('s', async () => {
      await first.promise;
      throw new Error('first failed');
    });
    const p2 = runExclusive('s', async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    // Second must wait for the first to settle, even though it will reject.
    expect(secondStarted).toBe(false);

    first.resolve();
    await expect(p1).rejects.toThrow('first failed');
    await p2;
    expect(secondStarted).toBe(true);
  });
});
