import { describe, it, expect, vi } from 'vitest';
import { createResponseCache } from './response-cache.js';

describe('response-cache', () => {
  it('computes on miss and reuses within the TTL', async () => {
    const cache = createResponseCache<number>({ ttlMs: 1_000 });
    const compute = vi.fn(async () => 42);
    const now = 1_000_000;

    expect(await cache.getOrCompute('k', compute, now)).toBe(42);
    expect(await cache.getOrCompute('k', compute, now + 999)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes once the TTL has elapsed', async () => {
    const cache = createResponseCache<number>({ ttlMs: 1_000 });
    let n = 0;
    const compute = vi.fn(async () => ++n);
    const now = 1_000_000;

    expect(await cache.getOrCompute('k', compute, now)).toBe(1);
    expect(await cache.getOrCompute('k', compute, now + 1_001)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('keys are independent', async () => {
    const cache = createResponseCache<string>({ ttlMs: 1_000 });
    const now = 1_000_000;
    expect(await cache.getOrCompute('a', async () => 'A', now)).toBe('A');
    expect(await cache.getOrCompute('b', async () => 'B', now)).toBe('B');
  });

  it('single-flights concurrent calls for the same key onto one compute', async () => {
    const cache = createResponseCache<number>({ ttlMs: 1_000 });
    let resolve!: (v: number) => void;
    const compute = vi.fn(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        })
    );
    const now = 1_000_000;

    // Three concurrent callers before the first compute settles.
    const p1 = cache.getOrCompute('k', compute, now);
    const p2 = cache.getOrCompute('k', compute, now);
    const p3 = cache.getOrCompute('k', compute, now);
    expect(compute).toHaveBeenCalledTimes(1);

    resolve(7);
    expect(await Promise.all([p1, p2, p3])).toEqual([7, 7, 7]);
  });

  it('does not cache a rejected compute and retries the next call', async () => {
    const cache = createResponseCache<number>({ ttlMs: 1_000 });
    const now = 1_000_000;

    const boom = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(cache.getOrCompute('k', boom, now)).rejects.toThrow('boom');

    // Failure cleared the in-flight slot and was not stored — next call recomputes.
    const ok = vi.fn(async () => 5);
    expect(await cache.getOrCompute('k', ok, now)).toBe(5);
  });

  it('reset clears cached entries', async () => {
    const cache = createResponseCache<number>({ ttlMs: 10_000 });
    const now = 1_000_000;
    await cache.getOrCompute('a', async () => 1, now);
    await cache.getOrCompute('b', async () => 2, now);
    expect(cache.size()).toBe(2);

    cache.reset();
    expect(cache.size()).toBe(0);
  });

  it('ttlMs: 0 disables reuse (always fresh) but still single-flights', async () => {
    const cache = createResponseCache<number>({ ttlMs: 0 });
    let n = 0;
    const compute = vi.fn(async () => ++n);
    const now = 1_000_000;

    // Sequential calls always recompute.
    expect(await cache.getOrCompute('k', compute, now)).toBe(1);
    expect(await cache.getOrCompute('k', compute, now)).toBe(2);

    // But genuinely concurrent calls still collapse onto one compute.
    let resolve!: (v: number) => void;
    const slow = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const p1 = cache.getOrCompute('k', slow, now);
    const p2 = cache.getOrCompute('k', slow, now);
    expect(slow).toHaveBeenCalledTimes(1);
    resolve(99);
    expect(await Promise.all([p1, p2])).toEqual([99, 99]);
  });

  it('evicts the oldest half when maxEntries is exceeded', async () => {
    const cache = createResponseCache<number>({ ttlMs: 100_000, maxEntries: 4 });
    // Insert 5 keys with increasing expiry so eviction order is deterministic.
    for (let i = 0; i < 5; i++) {
      await cache.getOrCompute(`k${i}`, async () => i, 1_000 + i);
    }
    // 5 > 4 triggered eviction of the oldest ~half (2 entries): k0, k1 gone.
    expect(cache.size()).toBe(3);
  });
});
