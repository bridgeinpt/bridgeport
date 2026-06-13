/**
 * Short-TTL, single-flight response cache for read-heavy GET endpoints.
 *
 * The monitoring pages (server/service/database metrics history, env metrics
 * summary) are polled by every open dashboard every ~30s, and the underlying
 * data only changes when a new metrics sample lands (default every 5 min).
 * The query itself is sub-millisecond and index-served — the cost that shows
 * up as the p99 tail under concurrency is the *synchronous* per-request work
 * (columnar transform + fast-json-stringify over a large payload) serializing
 * on the single Node event loop. N concurrent identical requests each pay that
 * cost independently.
 *
 * This cache attacks that two ways:
 *
 *   1. Single-flight: while one request is computing a key, concurrent
 *      requests for the SAME key await the in-flight promise instead of
 *      kicking off their own compute. This alone collapses a burst of N
 *      identical requests into one compute — the dominant win when a path is
 *      hit by many connections at once.
 *
 *   2. TTL reuse: a freshly-computed value is served from memory for `ttlMs`
 *      afterwards. With a 5s TTL and a 5-min sample interval, the served value
 *      is at most a few seconds stale — well within what a 30s-refreshing
 *      chart already tolerates, and the delta-refresh path (issue #171) keeps
 *      steady-state freshness regardless.
 *
 * Per-process state is sufficient: in a multi-process deployment each process
 * caches independently and still coalesces its own concurrent load. Entries
 * are kept in a Map bounded to `maxEntries`; on overflow the oldest ~half (by
 * expiry) is evicted in one pass so we don't pay eviction on every insert.
 *
 * Only cache idempotent, argument-complete reads. Callers MUST build a key
 * that captures every input that changes the response (env id, query params).
 */

import { config } from './config.js';

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = config.RESPONSE_CACHE_MAX_ENTRIES;

// Integration tests run in a shared process (isolate: false) with these caches
// as module-level singletons, and they routinely read → mutate → read the same
// resource within one test. A non-zero TTL would serve the pre-mutation value
// and flake those assertions. Disabling reuse under test keeps every read
// fresh while single-flight (which only dedupes genuinely concurrent calls)
// stays active. The TTL-reuse path is covered directly in the unit test via an
// injected `now`.
const isTest = process.env.NODE_ENV === 'test';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface ResponseCache<T> {
  /**
   * Return the cached value for `key` if fresh, otherwise await an existing
   * in-flight compute for the same key, otherwise run `compute()` and cache
   * its result. A rejected `compute()` is never cached and clears the
   * in-flight slot so the next caller retries.
   */
  getOrCompute(key: string, compute: () => Promise<T>, now?: number): Promise<T>;
  /** For tests. */
  reset(): void;
  size(): number;
}

export function createResponseCache<T>(options?: {
  ttlMs?: number;
  maxEntries?: number;
}): ResponseCache<T> {
  const ttlMs = options?.ttlMs ?? (isTest ? 0 : DEFAULT_TTL_MS);
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function store(key: string, value: T, now: number): void {
    entries.set(key, { value, expiresAt: now + ttlMs });
    if (entries.size > maxEntries) {
      // Evict the oldest ~half so we don't pay this on every insert.
      const sorted = Array.from(entries.entries()).sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt
      );
      const evict = Math.floor(sorted.length / 2);
      for (let i = 0; i < evict; i++) entries.delete(sorted[i]![0]);
    }
  }

  return {
    getOrCompute(key, compute, now = Date.now()) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);

      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = compute()
        .then((value) => {
          store(key, value, now);
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, promise);
      return promise;
    },
    reset() {
      entries.clear();
      inflight.clear();
    },
    size() {
      return entries.size;
    },
  };
}
