/**
 * Transient SQLite-contention handling (issue #299).
 *
 * BRIDGEPORT serves every request through ONE synchronous better-sqlite3
 * connection, so within the process all DB work is serialized and cannot
 * self-contend. Contention only arises when ANOTHER writer holds the SQLite
 * write lock — a long-running external transaction, a WAL checkpoint, or a
 * second process touching the DB file (e.g. a test harness that resets state
 * between runs). Two failure modes result:
 *
 *   1. SQLITE_BUSY — the lock is held when we try to write. `busy_timeout`
 *      makes us BLOCK up to N ms, then the driver gives up. The adapter maps
 *      SQLITE_BUSY to a SocketTimeout, which Prisma surfaces as **P1008**.
 *   2. SQLITE_BUSY_SNAPSHOT — our read snapshot went stale and we tried to
 *      upgrade to a write. SQLite returns this IMMEDIATELY and `busy_timeout`
 *      does NOT apply (the busy handler is never invoked), so blocking can't
 *      help — only retrying with a fresh snapshot can.
 *
 * Both are transient and safe to retry. The retry is applied PER OPERATION (the
 * extension wraps `$allOperations`, which fires once per model/raw call — and,
 * inside a `$transaction`, once per inner statement). That granularity is safe:
 * a SQLite statement is atomic, so a statement that fails with a transient
 * error has NOT applied; retrying re-runs only that statement, leaving any
 * earlier statements in the same open transaction untouched — there is no
 * double-write. If the contention instead aborts the whole transaction, the
 * retried statement simply fails again and the transaction rolls back, so the
 * worst case is a retryable 503 rather than partial/duplicated state.
 *
 * Left unhandled, both surfaced to clients as an opaque 500. This module retries
 * them transparently and, when retries are exhausted, lets the error handler
 * return a retryable 503 instead.
 */

import { Prisma } from '@prisma/client';
import { config } from './config.js';

/**
 * Prisma error codes that represent transient, retryable contention rather than
 * a deterministic client/data error.
 *
 *  - P1008  Operations timed out — the adapter maps SQLITE_BUSY to a
 *           SocketTimeout, which the engine reports as a timeout.
 *  - P1017  Server has closed the connection.
 *  - P2024  Timed out fetching a new connection from the pool.
 *  - P2034  Transaction failed due to a write conflict or a deadlock — retry.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P1008', 'P1017', 'P2024', 'P2034']);

/**
 * Raw/unknown errors (e.g. from `$queryRaw`, or driver errors that don't carry
 * a Prisma code) are matched on message. Covers the SQLite busy variants.
 */
const TRANSIENT_MESSAGE_RE =
  /SQLITE_BUSY|database is locked|database table is locked|database schema is locked|SocketTimeout/i;

/**
 * True when an error represents transient SQLite contention that is safe to
 * retry / surface as a retryable 503.
 */
export function isTransientDbError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    TRANSIENT_PRISMA_CODES.has(error.code)
  ) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return TRANSIENT_MESSAGE_RE.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter, capped at DB_RETRY_MAX_DELAY_MS.
 * `attempt` is 1-based (the delay applied AFTER attempt N, before attempt N+1).
 * The jitter spreads concurrent retriers so they don't all re-collide on the
 * same tick when the lock frees.
 */
function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(
    config.DB_RETRY_MAX_DELAY_MS,
    config.DB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  return Math.floor(Math.random() * ceiling);
}

/**
 * Run a DB thunk, retrying transient contention errors with jittered backoff.
 * Non-transient errors (validation, unique constraint, not-found, …) are
 * rethrown immediately. Exported for direct use and for unit testing.
 */
export async function withDbRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = Math.max(1, config.DB_RETRY_MAX_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === maxAttempts) throw error;
      await delay(backoffDelayMs(attempt));
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastError;
}

/**
 * Prisma client extension that transparently retries transient SQLite
 * contention for every operation (model queries AND raw queries). Applied once
 * to the singleton client in db.ts, so every call site benefits without any
 * per-route wiring.
 *
 * Note on timing: each attempt may first block synchronously for up to
 * SQLITE_BUSY_TIMEOUT_MS (better-sqlite3's busy-wait), so that PRAGMA is kept
 * short and this async backoff — which frees the event loop between attempts —
 * carries longer contention. Worst-case event-loop stall ≈ busy_timeout ×
 * DB_RETRY_MAX_ATTEMPTS, so the two are tuned together.
 */
export const dbRetryExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'transient-contention-retry',
    query: {
      $allOperations({ args, query }) {
        return withDbRetry(() => query(args));
      },
    },
  })
);
