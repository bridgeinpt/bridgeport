/**
 * Atomic multi-resource sync batch (issue #130).
 *
 * Wraps N config-file syncs into a single "all-or-nothing" or "best-effort"
 * batch with optional rollback. The current iteration supports `config-file-sync`
 * ops only — `service-deploy` is explicitly out of scope for v1 and is rejected
 * upstream at the route layer.
 *
 * Persistence model:
 *  - One `SyncBatch` row per request, created BEFORE any op runs. This means
 *    a crash mid-batch leaves a `status="pending"` row with the per-op rows
 *    behind it, which is the desired forensic state.
 *  - One `SyncBatchOperation` row per op. Updated in-place as the op
 *    transitions through pending → ok / failed / rolled_back / rollback_failed.
 *
 * Rollback semantics:
 *  - On a failure with `rollbackOnFailure=true`, we walk back over the already
 *    successful ops in reverse, restore their previous `ConfigFile.content`
 *    (snapshotted before the op ran), and re-call the same sync helper to
 *    push the prior content out to the attached services.
 *  - A rollback that itself fails marks the op as `rollback_failed` and the
 *    batch as `partial` — we couldn't make it atomic, but we recorded that
 *    fact explicitly so an operator can intervene.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
// Canonical JSON + body hashing live in lib/ so the MCP write-tool path (issue
// #208) can reuse them without importing this whole service. Re-exported here
// for the existing importers (the route + tests) that reference them via this
// module.
export { canonicalizeJson, hashCanonicalBody } from '../lib/canonical-json.js';
import {
  syncConfigFileToAttachedServices,
  type SyncOutcome,
} from './config-file-auto-resync.js';
import { logAudit } from './audit.js';
import { emitWebhookEvent } from './webhook-subscriptions.js';
import { syncUsageForConfigFile } from '../lib/key-usage-extraction.js';
import { getErrorMessage } from '../lib/helpers.js';

/** Actor identity fields, shape matches `actorFrom(request)` in ./audit.ts. */
export interface BatchActor {
  userId?: string;
  apiTokenId?: string;
  serviceAccountId?: string;
}

/** v1 op type — only config-file-sync is allowed. */
export interface ConfigFileSyncOperation {
  type: 'config-file-sync';
  configFileId: string;
}

export type SyncBatchInputOperation = ConfigFileSyncOperation;

export interface BatchExecuteInput {
  operations: ReadonlyArray<SyncBatchInputOperation>;
  rollbackOnFailure: boolean;
  actor: BatchActor;
  /** Caller-supplied Idempotency-Key header (raw, untrimmed of casing). */
  idempotencyKey?: string;
  /** SHA-256 hex of canonical request body — computed once by the route. */
  idempotencyBodyHash?: string;
}

/** Terminal status of a batch (matches the wire contract in issue #130). */
export type BatchStatus = 'ok' | 'partial' | 'rolled_back' | 'failed';

export type BatchOperationStatus =
  | 'pending'
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'rolled_back'
  | 'rollback_failed';

export interface BatchOperationResult {
  index: number;
  status: BatchOperationStatus;
  error?: { code?: string; message: string };
}

export interface BatchExecuteResult {
  batchId: string;
  status: BatchStatus;
  operations: BatchOperationResult[];
}

/** Marker thrown when an idempotency key is reused with a different body. */
export class IdempotencyKeyConflictError extends Error {
  constructor(message = 'Idempotency-Key reuse with a different request body') {
    super(message);
    this.name = 'IdempotencyKeyConflictError';
  }
}

/**
 * Find an existing batch with the same `Idempotency-Key`. Returns the prior
 * BatchExecuteResult (so the caller can replay it 1:1), or throws
 * IdempotencyKeyConflictError if the key was reused with a different body.
 *
 * Returns `null` if no matching key exists (fresh request — proceed to execute).
 */
export async function lookupIdempotentBatch(
  idempotencyKey: string,
  bodyHash: string
): Promise<BatchExecuteResult | null> {
  // Same key + same body: replay the cached result. Same key + different
  // body: conflict (per the issue, return 409).
  const sameBody = await prisma.syncBatch.findUnique({
    where: {
      idempotencyKey_idempotencyBodyHash: {
        idempotencyKey,
        idempotencyBodyHash: bodyHash,
      },
    },
    include: { operations: { orderBy: { index: 'asc' } } },
  });

  if (sameBody) {
    return batchRowToResult(sameBody);
  }

  const differentBody = await prisma.syncBatch.findFirst({
    where: {
      idempotencyKey,
      // Excludes the (same-key, same-body) row that findUnique already covered.
      NOT: { idempotencyBodyHash: bodyHash },
    },
    select: { id: true },
  });

  if (differentBody) {
    throw new IdempotencyKeyConflictError();
  }

  return null;
}

/**
 * Build a wire `BatchExecuteResult` from a persisted batch row + its ops.
 * Used by both `lookupIdempotentBatch` (for replays) and `GET /api/sync/batch/:id`.
 */
export function batchRowToResult(
  row: {
    id: string;
    status: string;
    operations: ReadonlyArray<{ index: number; status: string; error: string | null }>;
  }
): BatchExecuteResult {
  return {
    batchId: row.id,
    status: row.status as BatchStatus,
    operations: row.operations.map((op) => {
      const result: BatchOperationResult = {
        index: op.index,
        status: op.status as BatchOperationStatus,
      };
      const parsed = parseErrorJson(op.error);
      if (parsed) result.error = parsed;
      return result;
    }),
  };
}

/** Best-effort parse of the JSON we stash in `SyncBatchOperation.error`. */
function parseErrorJson(raw: string | null): { code?: string; message: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { code?: string; message?: string };
    if (typeof parsed?.message === 'string') {
      const out: { code?: string; message: string } = { message: parsed.message };
      if (typeof parsed.code === 'string') out.code = parsed.code;
      return out;
    }
  } catch {
    // Fall through.
  }
  // Older / malformed rows: surface the raw string so we don't drop the signal.
  return { message: raw };
}

interface OpRow {
  id: string;
  index: number;
  configFileId: string | null;
}

/**
 * Execute a batch. Idempotency lookup happens BEFORE we get here — the caller
 * is responsible for short-circuiting same-key replays.
 *
 * Never throws under normal operation: failures are recorded on the per-op
 * rows and reflected in the batch status. The function only throws on
 * unexpected DB errors (which the route layer surfaces as 500).
 */
export async function executeBatch(input: BatchExecuteInput): Promise<BatchExecuteResult> {
  const { operations, rollbackOnFailure, actor, idempotencyKey, idempotencyBodyHash } = input;

  // Single-environment scope: every config file in the batch must live in the
  // same environment. We resolve it lazily off the first op's config file so
  // an unknown id fails the same way as a regular sync (per-op "failed").
  let environmentId: string | null = null;

  // 1. Pre-resolve config files for environment scoping AND validation. We
  // hit the DB once with an `in` query and map the results back by id.
  const ids = operations.map((o) => o.configFileId);
  const preload = await prisma.configFile.findMany({
    where: { id: { in: ids } },
    select: { id: true, environmentId: true, content: true, isBinary: true, name: true },
  });
  const preloadById = new Map(preload.map((cf) => [cf.id, cf] as const));

  // Pick environment from the first resolvable config file. If the batch
  // mixes environments we reject the whole batch (single-environment scope
  // per the issue contract).
  for (const op of operations) {
    const cf = preloadById.get(op.configFileId);
    if (!cf) continue;
    if (environmentId === null) {
      environmentId = cf.environmentId;
    } else if (environmentId !== cf.environmentId) {
      // Mixed envs — we don't create a batch row at all, surface as a single
      // failed batch with all ops marked failed.
      return persistRejectedBatch(input, 'Batch spans multiple environments', preloadById);
    }
  }

  // 2. Persist the batch + its op rows up-front. This is what gives us
  // crash-recovery semantics: if the process dies mid-batch, the rows
  // already exist with status="pending".
  //
  // TOCTOU guard: lookupIdempotentBatch + this create are non-atomic. Two
  // concurrent requests with the same Idempotency-Key can both pass the
  // lookup and both reach `create`. The unique constraint on
  // (idempotencyKey, idempotencyBodyHash) makes the second one fail with
  // P2002. When that happens AND the caller supplied an idempotency key,
  // re-run the lookup — the other writer has now committed and we should
  // replay its result instead of returning 500.
  let batch;
  try {
    batch = await prisma.syncBatch.create({
      data: {
        status: 'pending',
        rollbackOnFailure,
        idempotencyKey: idempotencyKey ?? null,
        idempotencyBodyHash: idempotencyBodyHash ?? null,
        userId: actor.userId ?? null,
        apiTokenId: actor.apiTokenId ?? null,
        serviceAccountId: actor.serviceAccountId ?? null,
        environmentId: environmentId ?? null,
        operations: {
          create: operations.map((op, index) => ({
            index,
            type: op.type,
            configFileId: op.configFileId,
            status: 'pending',
          })),
        },
      },
      include: { operations: { orderBy: { index: 'asc' } } },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      idempotencyKey &&
      idempotencyBodyHash
    ) {
      const replay = await lookupIdempotentBatch(idempotencyKey, idempotencyBodyHash);
      if (replay) return replay;
    }
    throw err;
  }

  // Working copy of per-op state. We update DB rows in-place and mirror the
  // status into this array so we can build the final response without a
  // re-read at the end.
  const opRows: OpRow[] = batch.operations.map((o) => ({
    id: o.id,
    index: o.index,
    configFileId: o.configFileId,
  }));
  const opStatus: BatchOperationStatus[] = opRows.map(() => 'pending');
  const opErrors: Array<{ code?: string; message: string } | undefined> = opRows.map(() => undefined);

  // Track which ops have successfully run so the rollback path knows what to
  // unwind, and in what order.
  const succeededOps: number[] = []; // indices of ops that returned ok

  let firstFailureIndex: number | null = null;

  // 3. Iterate ops in order, calling the existing helper. We snapshot the
  // prior `ConfigFile.content` BEFORE running so a later rollback can restore
  // it byte-for-byte.
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const opRow = opRows[i];
    const cf = preloadById.get(op.configFileId);

    // Snapshot prior content first. If the config file vanished between
    // preload and now, treat the op as a regular failure.
    if (!cf) {
      await markOpFailed(opRow.id, 'NOT_FOUND', 'Config file not found');
      opStatus[i] = 'failed';
      opErrors[i] = { code: 'NOT_FOUND', message: 'Config file not found' };
      firstFailureIndex ??= i;
      if (rollbackOnFailure) break;
      continue;
    }

    await prisma.syncBatchOperation.update({
      where: { id: opRow.id },
      data: {
        previousContent: cf.content,
        previousIsBinary: cf.isBinary,
      },
    });

    let outcome: SyncOutcome | null;
    try {
      outcome = await syncConfigFileToAttachedServices(op.configFileId);
    } catch (err) {
      // The helper documents "never throws" but be defensive — if it does
      // throw, treat as a regular failure rather than crash the batch.
      const message = getErrorMessage(err, 'Unexpected sync failure');
      await markOpFailed(opRow.id, 'INTERNAL', message);
      opStatus[i] = 'failed';
      opErrors[i] = { code: 'INTERNAL', message };
      firstFailureIndex ??= i;
      if (rollbackOnFailure) break;
      continue;
    }

    if (!outcome) {
      // Config file disappeared mid-batch — same handling as the preload miss.
      await markOpFailed(opRow.id, 'NOT_FOUND', 'Config file not found');
      opStatus[i] = 'failed';
      opErrors[i] = { code: 'NOT_FOUND', message: 'Config file not found' };
      firstFailureIndex ??= i;
      if (rollbackOnFailure) break;
      continue;
    }

    // Anything other than a clean `ok` is treated as a failure for batch
    // accounting. `no_targets` deliberately counts as a failure here: a
    // batch caller asked us to sync N things and one of them had nothing
    // to do, which they want to know about (silent-success was the
    // original bug class — see issue #127).
    if (outcome.status !== 'ok') {
      const opError = {
        code: outcome.status.toUpperCase(),
        message: summarizeSyncFailure(outcome),
      };
      await prisma.syncBatchOperation.update({
        where: { id: opRow.id },
        data: {
          status: 'failed',
          error: JSON.stringify(opError),
          results: JSON.stringify(outcome.results),
          completedAt: new Date(),
        },
      });
      opStatus[i] = 'failed';
      opErrors[i] = opError;
      firstFailureIndex ??= i;

      await writeAuditForOp({
        actor,
        batchId: batch.id,
        configFileId: op.configFileId,
        configFileName: outcome.configFileName,
        environmentId: outcome.environmentId,
        success: false,
        results: outcome.results,
        opStatus: outcome.status,
      });

      if (rollbackOnFailure) break;
      continue;
    }

    // Success path
    await prisma.syncBatchOperation.update({
      where: { id: opRow.id },
      data: {
        status: 'ok',
        results: JSON.stringify(outcome.results),
        completedAt: new Date(),
      },
    });
    opStatus[i] = 'ok';
    succeededOps.push(i);

    await writeAuditForOp({
      actor,
      batchId: batch.id,
      configFileId: op.configFileId,
      configFileName: outcome.configFileName,
      environmentId: outcome.environmentId,
      success: true,
      results: outcome.results,
      opStatus: outcome.status,
    });
  }

  // 4. Decide what happens next based on `firstFailureIndex` and the
  // rollbackOnFailure flag.
  let finalStatus: BatchStatus;
  let anyRollbackFailed = false;

  if (firstFailureIndex === null) {
    // All ops succeeded.
    finalStatus = 'ok';
  } else if (rollbackOnFailure) {
    // Mark anything we never attempted as "skipped".
    for (let i = firstFailureIndex + 1; i < operations.length; i++) {
      if (opStatus[i] === 'pending') {
        await prisma.syncBatchOperation.update({
          where: { id: opRows[i].id },
          data: { status: 'skipped', completedAt: new Date() },
        });
        opStatus[i] = 'skipped';
      }
    }

    // Walk back the succeeded ops in reverse, restoring previous content.
    for (let j = succeededOps.length - 1; j >= 0; j--) {
      const i = succeededOps[j];
      const op = operations[i];
      const opRow = opRows[i];
      const cf = preloadById.get(op.configFileId);
      if (!cf) {
        // Defensive: shouldn't happen because we used it during forward pass.
        await prisma.syncBatchOperation.update({
          where: { id: opRow.id },
          data: { status: 'rollback_failed', rollbackError: 'Config file vanished before rollback', completedAt: new Date() },
        });
        opStatus[i] = 'rollback_failed';
        anyRollbackFailed = true;
        continue;
      }

      try {
        // Restore prior content first (in-DB), then push to servers.
        // Wrap in a transaction so:
        //   1. We create a FileHistory row capturing the CURRENT content
        //      (the post-forward-sync content this rollback is replacing) —
        //      matches PATCH /api/config-files/:id semantics where each
        //      content change leaves a history row of the prior state.
        //   2. We update ConfigFile.content + isBinary back to the
        //      snapshotted previous values.
        //   3. We re-call syncUsageForConfigFile so Secret/Var usage rows
        //      reflect the restored content. The forward path's helper does
        //      this, but the direct UPDATE we were doing previously bypassed
        //      it (leaving stale usage rows pointing at the forward content).
        await prisma.$transaction(async (tx) => {
          // Re-read inside the tx so we record the actual current row state
          // (the forward-sync content) as the "previous" content in history.
          const current = await tx.configFile.findUnique({
            where: { id: op.configFileId },
            select: { content: true },
          });
          if (current) {
            await tx.fileHistory.create({
              data: {
                content: current.content,
                configFileId: op.configFileId,
                editedById: actor.userId ?? null,
              },
            });
          }
          const restored = await tx.configFile.update({
            where: { id: op.configFileId },
            data: { content: cf.content, isBinary: cf.isBinary },
          });
          await syncUsageForConfigFile(tx, restored);
        });

        const restoreOutcome = await syncConfigFileToAttachedServices(op.configFileId);
        // `no_targets` during rollback means the restore didn't actually
        // push anywhere — treat as a rollback failure for symmetry with the
        // forward-pass policy (issue #127): a sync that touched no targets
        // shouldn't be silently logged as success.
        if (!restoreOutcome || restoreOutcome.status !== 'ok') {
          const reason = restoreOutcome
            ? summarizeSyncFailure(restoreOutcome)
            : 'Config file not found during rollback';
          await prisma.syncBatchOperation.update({
            where: { id: opRow.id },
            data: { status: 'rollback_failed', rollbackError: reason, completedAt: new Date() },
          });
          opStatus[i] = 'rollback_failed';
          anyRollbackFailed = true;

          await writeAuditForOp({
            actor,
            batchId: batch.id,
            configFileId: op.configFileId,
            configFileName: restoreOutcome?.configFileName ?? cf.name,
            environmentId: restoreOutcome?.environmentId ?? null,
            success: false,
            results: restoreOutcome?.results ?? [],
            opStatus: restoreOutcome?.status ?? 'failed',
            rollback: true,
          });
        } else {
          await prisma.syncBatchOperation.update({
            where: { id: opRow.id },
            data: { status: 'rolled_back', completedAt: new Date() },
          });
          opStatus[i] = 'rolled_back';

          await writeAuditForOp({
            actor,
            batchId: batch.id,
            configFileId: op.configFileId,
            configFileName: restoreOutcome.configFileName,
            environmentId: restoreOutcome.environmentId,
            success: true,
            results: restoreOutcome.results,
            opStatus: restoreOutcome.status,
            rollback: true,
          });
        }
      } catch (err) {
        const message = getErrorMessage(err, 'Rollback failed');
        await prisma.syncBatchOperation.update({
          where: { id: opRow.id },
          data: { status: 'rollback_failed', rollbackError: message, completedAt: new Date() },
        });
        opStatus[i] = 'rollback_failed';
        anyRollbackFailed = true;
      }
    }

    finalStatus = anyRollbackFailed ? 'partial' : 'rolled_back';
  } else {
    // Best-effort: at least one failure happened, no rollback. The forward
    // loop already attempted every op (no `break`), so opStatus reflects
    // every attempt.
    const okCount = opStatus.filter((s) => s === 'ok').length;
    finalStatus = okCount === 0 ? 'failed' : 'partial';
  }

  // 5. Persist final batch status.
  await prisma.syncBatch.update({
    where: { id: batch.id },
    data: { status: finalStatus, completedAt: new Date() },
  });

  // Fire-and-forget webhook event with the FINAL batch status in the payload
  // (issue #126). One event per batch — not per terminal sub-status. Skipped
  // when the batch couldn't be scoped to an environment (mixed/unknown env).
  if (environmentId) {
    void emitWebhookEvent('sync.completed', environmentId, {
      batchId: batch.id,
      status: finalStatus,
      operationCount: opStatus.length,
    });
  }

  return {
    batchId: batch.id,
    status: finalStatus,
    operations: opStatus.map((status, index) => {
      const result: BatchOperationResult = { index, status };
      if (opErrors[index]) result.error = opErrors[index];
      return result;
    }),
  };
}

/**
 * Mark a single op row as failed in a single update. Used when we hit a
 * pre-sync error (config file not found, helper threw) and want to bail out
 * of the forward pass.
 */
async function markOpFailed(opId: string, code: string, message: string): Promise<void> {
  await prisma.syncBatchOperation.update({
    where: { id: opId },
    data: {
      status: 'failed',
      error: JSON.stringify({ code, message }),
      completedAt: new Date(),
    },
  });
}

/** Build a short human-readable failure summary from a SyncOutcome. */
function summarizeSyncFailure(outcome: SyncOutcome): string {
  if (outcome.status === 'no_targets') {
    return `Config file "${outcome.configFileName}" is not attached to any service`;
  }
  if (outcome.status === 'failed') {
    const firstErr = outcome.results.find((r) => !r.success && r.error)?.error;
    return firstErr
      ? `All targets failed: ${firstErr}`
      : `All ${outcome.targetsAttempted} targets failed`;
  }
  // partial
  const firstErr = outcome.results.find((r) => !r.success && r.error)?.error;
  return firstErr
    ? `${outcome.targetsFailed}/${outcome.targetsAttempted} targets failed: ${firstErr}`
    : `${outcome.targetsFailed}/${outcome.targetsAttempted} targets failed`;
}

/**
 * Persist a SyncBatch in the "rejected at submission time" shape — used for
 * cases like mixed-environment batches where we don't even start executing.
 * Every op is marked `failed` with the same reason.
 */
async function persistRejectedBatch(
  input: BatchExecuteInput,
  reason: string,
  preloadById: Map<string, { id: string; environmentId: string }>
): Promise<BatchExecuteResult> {
  // We intentionally DO NOT persist idempotencyKey / idempotencyBodyHash on
  // rejected batches. Pre-execution validation failures must not consume the
  // key: a client who fixes the body and retries with the same key should
  // succeed (HTTP Idempotency-Key spec semantics — keys are tied to
  // EXECUTED operations, not rejected submissions). Storing the key here
  // would poison it: lookupIdempotentBatch would find the rejected row and
  // either replay it (wrong, the new body is different) or throw a 409.
  const batch = await prisma.syncBatch.create({
    data: {
      status: 'failed',
      rollbackOnFailure: input.rollbackOnFailure,
      idempotencyKey: null,
      idempotencyBodyHash: null,
      userId: input.actor.userId ?? null,
      apiTokenId: input.actor.apiTokenId ?? null,
      serviceAccountId: input.actor.serviceAccountId ?? null,
      // Best-effort environmentId: pick whichever the first op resolves to,
      // so audit-log filtering by env still works for the diagnostics rows.
      environmentId: preloadById.get(input.operations[0]?.configFileId ?? '')?.environmentId ?? null,
      completedAt: new Date(),
      operations: {
        create: input.operations.map((op, index) => ({
          index,
          type: op.type,
          configFileId: op.configFileId,
          status: 'failed',
          error: JSON.stringify({ code: 'VALIDATION_ERROR', message: reason }),
          completedAt: new Date(),
        })),
      },
    },
    include: { operations: { orderBy: { index: 'asc' } } },
  });

  // Finding 6: rejected batches were not generating any AuditLog row, so
  // operators had no breadcrumb in the audit trail. Write one summary row
  // capturing why the batch was rejected. Use the new `batchId` param on
  // logAudit (Finding 5) so the audit row is linked back to the batch.
  const distinctEnvs = Array.from(
    new Set(
      input.operations
        .map((op) => preloadById.get(op.configFileId)?.environmentId)
        .filter((id): id is string => typeof id === 'string')
    )
  );
  await logAudit({
    action: 'sync_batch_rejected',
    resourceType: 'sync_batch',
    resourceId: batch.id,
    success: false,
    batchId: batch.id,
    userId: input.actor.userId,
    apiTokenId: input.actor.apiTokenId,
    serviceAccountId: input.actor.serviceAccountId,
    details: {
      reason,
      operationCount: input.operations.length,
      environmentIds: distinctEnvs,
    },
  });

  return batchRowToResult(batch);
}

/**
 * Write a per-op audit-log entry linked back to the batch via `batchId`.
 * Mirrors the action used by the standalone sync route (`sync_files`) so
 * existing audit filters keep working.
 */
async function writeAuditForOp(args: {
  actor: BatchActor;
  batchId: string;
  configFileId: string;
  configFileName: string;
  environmentId: string | null | undefined;
  success: boolean;
  results: unknown;
  opStatus: string;
  rollback?: boolean;
}): Promise<void> {
  // batchId is written directly via logAudit (AuditLogParams.batchId). The
  // earlier implementation did a follow-up findFirst+update to backfill the
  // column, which was both racy (two concurrent batches touching the same
  // resource could swap their batchId backfills) and wasteful (two extra
  // queries per op).
  await logAudit({
    ...args.actor,
    action: args.rollback ? 'sync_files_rollback' : 'sync_files',
    resourceType: 'config_file',
    resourceId: args.configFileId,
    resourceName: args.configFileName,
    details: {
      batchId: args.batchId,
      results: args.results,
      status: args.opStatus,
      ...(args.rollback ? { rollback: true } : {}),
    },
    success: args.success,
    environmentId: args.environmentId ?? undefined,
    batchId: args.batchId,
  });
}
