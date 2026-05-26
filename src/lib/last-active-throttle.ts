/**
 * Throttle "last activity" timestamp writes (User.lastActiveAt,
 * ApiToken.lastUsedAt).
 *
 * Under load — multiple authenticated requests per second — every request
 * was firing a fire-and-forget `prisma.update({ lastActiveAt: now })`. Each
 * write competes for SQLite's single writer lock, and even though the
 * caller doesn't await it, the resulting tail latency shows up on the
 * read-heavy responses sharing the same DB.
 *
 * The product semantics ("when did this user last hit the API") only need
 * minute-level precision, so we throttle: at most one update per id per
 * `windowMs`. Per-process state is sufficient — in a multi-process
 * deployment, each process throttles independently and writes still
 * coalesce at roughly the same cadence.
 *
 * Entries are kept in a Map; when it grows past `maxEntries` the oldest
 * (lowest stored timestamp) half is evicted in one pass. That keeps memory
 * bounded without per-set bookkeeping.
 */

const DEFAULT_WINDOW_MS = 60_000; // one minute
const DEFAULT_MAX_ENTRIES = 10_000;

export interface Throttle {
  /** Returns true if a write should happen now; updates the internal stamp. */
  shouldWrite(id: string, now?: number): boolean;
  /** For tests. */
  reset(): void;
  size(): number;
}

export function createThrottle(options?: {
  windowMs?: number;
  maxEntries?: number;
}): Throttle {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const stamps = new Map<string, number>();

  return {
    shouldWrite(id, now = Date.now()) {
      const last = stamps.get(id);
      if (last !== undefined && now - last < windowMs) return false;
      stamps.set(id, now);
      if (stamps.size > maxEntries) {
        // Evict the oldest ~half so we don't pay this on every insert.
        const entries = Array.from(stamps.entries()).sort((a, b) => a[1] - b[1]);
        const evict = Math.floor(entries.length / 2);
        for (let i = 0; i < evict; i++) stamps.delete(entries[i]![0]);
      }
      return true;
    },
    reset() {
      stamps.clear();
    },
    size() {
      return stamps.size;
    },
  };
}

// Process-wide throttles for the two write sites.
export const userLastActiveThrottle = createThrottle();
export const apiTokenLastUsedThrottle = createThrottle();
