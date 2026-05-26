/**
 * In-process notification queue.
 *
 * Push system-notification fan-out off the request path: the request handler
 * enqueues a job and returns immediately. A scheduler-driven consumer drains
 * the queue with batched DB reads (single notificationType lookup, single
 * findMany for preferences/users, single environment lookup, bulk createMany).
 *
 * This is fine as in-process state — BRIDGEPORT is single-process.
 */

import { randomUUID } from 'crypto';
import { getErrorMessage } from '../lib/helpers.js';
import type { NotificationTypeCode } from './notifications.js';

export interface NotificationJob {
  id: string;
  typeCode: NotificationTypeCode;
  environmentId: string | null;
  data: Record<string, unknown>;
  enqueuedAt: number;
}

// Job processor signature. Real implementation is wired in by notifications.ts
// to avoid a circular import at module load time.
export type JobProcessor = (job: NotificationJob) => Promise<void>;

let processor: JobProcessor | null = null;

// Soft cap to surface unbounded growth (e.g. consumer stalled). We still enqueue
// past the cap — dropping notifications silently is worse than memory pressure.
const SOFT_CAP = 1000;
let softCapWarned = false;

const queue = new Map<string, NotificationJob>();

// Drains the queue in the background, kicked by scheduler interval and by
// setImmediate on every enqueue so empty-queue intervals are no-ops.
let draining = false;

/**
 * Register the job processor. Called once at module init time from notifications.ts.
 */
export function setJobProcessor(fn: JobProcessor): void {
  processor = fn;
}

/**
 * Enqueue a system-notification fan-out job. Returns the assigned jobId
 * synchronously and schedules a drain on the next tick.
 */
export function enqueue(
  typeCode: NotificationTypeCode,
  environmentId: string | null,
  data: Record<string, unknown> = {}
): string {
  const job: NotificationJob = {
    id: randomUUID(),
    typeCode,
    environmentId,
    data,
    enqueuedAt: Date.now(),
  };
  queue.set(job.id, job);

  if (queue.size >= SOFT_CAP && !softCapWarned) {
    softCapWarned = true;
    console.warn(
      `[NotificationQueue] Soft cap reached (${queue.size} pending jobs). Consumer may be stalled.`
    );
  } else if (queue.size < SOFT_CAP / 2 && softCapWarned) {
    softCapWarned = false;
  }

  // Kick a drain on the next tick so single-job enqueues don't wait for the
  // scheduler interval. Multiple concurrent calls coalesce via the `draining`
  // flag inside drain().
  setImmediate(() => {
    drain().catch((err) => {
      console.error('[NotificationQueue] Drain failed:', getErrorMessage(err));
    });
  });

  return job.id;
}

/**
 * Drain all currently-queued jobs. Re-entrant: concurrent calls return early.
 * Snapshots-then-deletes jobIds before processing so concurrent drains can't
 * double-process the same job.
 */
export async function drain(): Promise<void> {
  if (draining) return;
  if (queue.size === 0) return;

  draining = true;
  try {
    // Loop until queue is empty — new jobs enqueued during processing get picked up.
    while (queue.size > 0) {
      // Atomic snapshot: capture jobIds, delete from the queue, then process.
      // Anything enqueued after this snapshot is handled by the next loop iteration.
      const snapshot: NotificationJob[] = [];
      for (const [id, job] of queue) {
        snapshot.push(job);
        queue.delete(id);
      }

      if (!processor) {
        console.error(
          '[NotificationQueue] No processor registered; dropping snapshot of ' +
            `${snapshot.length} job(s). This is a wiring bug.`
        );
        continue;
      }

      // Process jobs sequentially to keep DB load predictable. Each job already
      // batches its own per-user fan-out internally, so this is not the bottleneck.
      for (const job of snapshot) {
        try {
          await processor(job);
        } catch (err) {
          console.error(
            `[NotificationQueue] Job ${job.id} (${job.typeCode}) failed:`,
            getErrorMessage(err)
          );
        }
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Number of pending jobs (used by tests and shutdown).
 */
export function size(): number {
  return queue.size;
}

/**
 * Flush pending jobs with a bounded wait. Called from server shutdown so we
 * don't lose freshly-enqueued notifications on SIGTERM. Bounded so a stuck
 * processor can't block shutdown indefinitely.
 */
export async function flushNotificationQueue(timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // Kick a drain in case the interval hasn't fired yet.
  drain().catch((err) => {
    console.error('[NotificationQueue] Flush drain failed:', getErrorMessage(err));
  });

  // Wait for the queue to empty or for the deadline to pass.
  while ((queue.size > 0 || draining) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (queue.size > 0) {
    console.warn(
      `[NotificationQueue] Flush deadline hit with ${queue.size} job(s) still pending.`
    );
  }
}

/**
 * Test-only: clear queue state without processing. Not used in production paths.
 */
export function _resetForTests(): void {
  queue.clear();
  draining = false;
  softCapWarned = false;
}
