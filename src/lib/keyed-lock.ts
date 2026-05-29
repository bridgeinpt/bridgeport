/**
 * Minimal in-process keyed mutex.
 *
 * `runExclusive(key, fn)` guarantees that, for a given key, only one `fn` runs
 * at a time across the whole process. Calls with the same key queue behind each
 * other in arrival order; calls with different keys run concurrently.
 *
 * Used to serialize Docker Compose operations that target the same compose file
 * on the same server — multiple BRIDGEPORT services can share one
 * docker-compose.yml, and concurrent `compose up --force-recreate` runs race on
 * recreating shared/dependency containers ("removal of container ... is already
 * in progress").
 *
 * Scope is per-process only — it does not coordinate across multiple BRIDGEPORT
 * instances. That is sufficient here: a single instance owns its scheduler and
 * deploy execution.
 */
const chains = new Map<string, Promise<void>>();

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();

  // Run fn only after the previous holder settles. prev is always a non-rejecting
  // tail (see below), so a failed predecessor never blocks or poisons the next.
  const result = prev.then(() => fn());

  // The chain link we store must never reject, or the next waiter's `.then`
  // would inherit the rejection. Swallow it here; the real result/rejection is
  // still surfaced to this caller via `result`.
  const tail = result.then(
    () => {},
    () => {}
  );
  chains.set(key, tail);

  // Drop the key once this is the last link, so the map doesn't grow unbounded.
  void tail.finally(() => {
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  });

  return result;
}
