import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the sync-batch executor (issue #130).
 *
 * Strategy:
 *   - Mock Prisma so we can drive `configFile.findMany`, `syncBatch.create`,
 *     and the per-op `update` calls without a real DB.
 *   - Mock `syncConfigFileToAttachedServices` so we can choose the outcome
 *     of each individual op (ok / failed / no_targets / partial).
 *   - Mock `logAudit` so we can assert linkage and details without writing
 *     real audit rows.
 *
 * The DB writes happen through a thin layer in the service. Rather than
 * model every row state in memory, we assert that the EXPECTED prisma calls
 * happened (with the right shape) and that the final BatchExecuteResult
 * matches the documented semantics.
 */

interface FakeOpRow {
  id: string;
  index: number;
  configFileId: string | null;
}

interface FakeBatchRow {
  id: string;
  status: string;
  rollbackOnFailure?: boolean;
  operations: ReadonlyArray<{ index: number; status: string; error: string | null }>;
}

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    configFile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    syncBatch: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    syncBatchOperation: {
      update: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('./config-file-auto-resync.js', () => ({
  syncConfigFileToAttachedServices: vi.fn(),
}));

vi.mock('./audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import {
  executeBatch,
  lookupIdempotentBatch,
  IdempotencyKeyConflictError,
  canonicalizeJson,
  hashCanonicalBody,
  batchRowToResult,
  type BatchExecuteInput,
} from './sync-batch.js';
import { syncConfigFileToAttachedServices } from './config-file-auto-resync.js';
import { logAudit } from './audit.js';

/**
 * Helper: simulate `prisma.syncBatch.create` returning an inserted batch
 * with one op row per input op. Each op gets a deterministic id so tests
 * can assert update calls without coupling to insertion order.
 */
function mockBatchCreate(input: { id?: string; rollbackOnFailure?: boolean; opCount: number; ops?: Array<{ configFileId: string | null }> }): FakeBatchRow {
  const batchId = input.id ?? 'batch-1';
  const operations: FakeOpRow[] = Array.from({ length: input.opCount }, (_, i) => ({
    id: `op-${i}`,
    index: i,
    configFileId: input.ops?.[i]?.configFileId ?? `cf-${i}`,
  }));
  const row = {
    id: batchId,
    status: 'pending',
    rollbackOnFailure: input.rollbackOnFailure ?? true,
    operations: operations.map((o) => ({ index: o.index, status: 'pending', error: null })),
  };
  mockPrisma.syncBatch.create.mockResolvedValue({
    ...row,
    // The executor uses `batch.operations` directly to seed its working
    // copy; expose the real op `id` here so update calls land correctly.
    operations: operations.map((o) => ({ ...o, status: 'pending', error: null })),
  });
  return row;
}

function okOutcome(overrides: Partial<{ configFileName: string; environmentId: string }> = {}) {
  return {
    status: 'ok' as const,
    success: true,
    results: [
      {
        serviceId: 'svc-1',
        serviceName: 'svc',
        serverName: 'host',
        targetPath: '/etc/x.conf',
        success: true,
      },
    ],
    targetsAttempted: 1,
    targetsSucceeded: 1,
    targetsFailed: 0,
    configFileName: overrides.configFileName ?? 'cf-name',
    environmentId: overrides.environmentId ?? 'env-1',
  };
}

function failedOutcome(overrides: Partial<{ configFileName: string; environmentId: string }> = {}) {
  return {
    status: 'failed' as const,
    success: false,
    results: [
      {
        serviceId: 'svc-1',
        serviceName: 'svc',
        serverName: 'host',
        targetPath: '/etc/x.conf',
        success: false,
        error: 'permission denied',
      },
    ],
    targetsAttempted: 1,
    targetsSucceeded: 0,
    targetsFailed: 1,
    configFileName: overrides.configFileName ?? 'cf-name',
    environmentId: overrides.environmentId ?? 'env-1',
  };
}

function baseActor() {
  return { userId: 'user-1', apiTokenId: 'tok-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: in-place ops just resolve, single-row updates return {}.
  mockPrisma.syncBatchOperation.update.mockResolvedValue({});
  mockPrisma.syncBatch.update.mockResolvedValue({});
  mockPrisma.configFile.update.mockResolvedValue({});
  // Audit backfill: by default nothing to find (audit linkage is best-effort).
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.update.mockResolvedValue({});
});

// ====================================================================
// canonicalizeJson + hashCanonicalBody
// ====================================================================

describe('canonicalizeJson', () => {
  it('produces the same string regardless of object key order', () => {
    const a = canonicalizeJson({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalizeJson({ a: 1, c: { x: 1, y: 2 }, b: 2 });
    expect(a).toBe(b);
  });

  it('preserves array order (semantically meaningful)', () => {
    const a = canonicalizeJson([1, 2, 3]);
    const b = canonicalizeJson([3, 2, 1]);
    expect(a).not.toBe(b);
    expect(a).toBe('[1,2,3]');
    expect(b).toBe('[3,2,1]');
  });

  it('handles primitives and null', () => {
    expect(canonicalizeJson(null)).toBe('null');
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson('hello')).toBe('"hello"');
    expect(canonicalizeJson(true)).toBe('true');
  });
});

describe('hashCanonicalBody', () => {
  it('same logical body hashes to the same value regardless of key order', () => {
    const h1 = hashCanonicalBody({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-1' }],
      rollbackOnFailure: true,
    });
    const h2 = hashCanonicalBody({
      rollbackOnFailure: true,
      operations: [{ configFileId: 'cf-1', type: 'config-file-sync' }],
    });
    expect(h1).toBe(h2);
  });

  it('different content hashes differently', () => {
    const h1 = hashCanonicalBody({ operations: [{ configFileId: 'cf-1' }] });
    const h2 = hashCanonicalBody({ operations: [{ configFileId: 'cf-2' }] });
    expect(h1).not.toBe(h2);
  });

  it('returns a 64-char hex string (sha-256)', () => {
    const h = hashCanonicalBody({ x: 1 });
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ====================================================================
// batchRowToResult
// ====================================================================

describe('batchRowToResult', () => {
  it('maps a persisted batch row into the wire result shape', () => {
    const result = batchRowToResult({
      id: 'batch-x',
      status: 'partial',
      operations: [
        { index: 0, status: 'ok', error: null },
        { index: 1, status: 'failed', error: JSON.stringify({ code: 'INTERNAL', message: 'boom' }) },
      ],
    });
    expect(result.batchId).toBe('batch-x');
    expect(result.status).toBe('partial');
    expect(result.operations).toEqual([
      { index: 0, status: 'ok' },
      { index: 1, status: 'failed', error: { code: 'INTERNAL', message: 'boom' } },
    ]);
  });

  it('tolerates malformed error JSON by surfacing the raw string as the message', () => {
    const result = batchRowToResult({
      id: 'batch-y',
      status: 'failed',
      operations: [{ index: 0, status: 'failed', error: 'unstructured legacy error' }],
    });
    expect(result.operations[0].error).toEqual({ message: 'unstructured legacy error' });
  });
});

// ====================================================================
// lookupIdempotentBatch
// ====================================================================

describe('lookupIdempotentBatch', () => {
  it('returns the prior result for same key + same body', async () => {
    mockPrisma.syncBatch.findUnique.mockResolvedValue({
      id: 'batch-prior',
      status: 'ok',
      operations: [{ index: 0, status: 'ok', error: null }],
    });
    const result = await lookupIdempotentBatch('key-1', 'hash-1');
    expect(result).not.toBeNull();
    expect(result!.batchId).toBe('batch-prior');
    expect(result!.status).toBe('ok');
  });

  it('throws IdempotencyKeyConflictError when the key was used with a different body', async () => {
    mockPrisma.syncBatch.findUnique.mockResolvedValue(null);
    mockPrisma.syncBatch.findFirst.mockResolvedValue({ id: 'batch-other' });
    await expect(lookupIdempotentBatch('key-1', 'hash-1')).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError
    );
  });

  it('returns null when the key has never been seen', async () => {
    mockPrisma.syncBatch.findUnique.mockResolvedValue(null);
    mockPrisma.syncBatch.findFirst.mockResolvedValue(null);
    const result = await lookupIdempotentBatch('key-fresh', 'hash-fresh');
    expect(result).toBeNull();
  });
});

// ====================================================================
// executeBatch
// ====================================================================

describe('executeBatch', () => {
  it('all ops succeed → batch status ok, every op status ok', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-1', content: 'B', isBinary: false, name: 'b' },
    ]);
    mockBatchCreate({ opCount: 2, ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-1' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValue(okOutcome());

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
      ],
      rollbackOnFailure: true,
      actor: baseActor(),
    });

    expect(result.status).toBe('ok');
    expect(result.operations).toEqual([
      { index: 0, status: 'ok' },
      { index: 1, status: 'ok' },
    ]);
    expect(syncConfigFileToAttachedServices).toHaveBeenCalledTimes(2);
    // Final batch update sets status="ok".
    const finalUpdate = mockPrisma.syncBatch.update.mock.calls.at(-1)?.[0];
    expect(finalUpdate?.data?.status).toBe('ok');
  });

  it('rolls back successful ops in reverse on first failure when rollbackOnFailure=true', async () => {
    // 3 ops: 0 ok, 1 ok, 2 fails. With rollbackOnFailure=true we expect:
    //   - op 0 + 1: rolled_back (content restored + re-sync ok)
    //   - op 2: failed
    //   - batch status: rolled_back
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'prev-0', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-1', content: 'prev-1', isBinary: false, name: 'b' },
      { id: 'cf-2', environmentId: 'env-1', content: 'prev-2', isBinary: false, name: 'c' },
    ]);
    mockBatchCreate({
      opCount: 3,
      ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-1' }, { configFileId: 'cf-2' }],
    });
    vi.mocked(syncConfigFileToAttachedServices)
      // forward pass
      .mockResolvedValueOnce(okOutcome())
      .mockResolvedValueOnce(okOutcome())
      .mockResolvedValueOnce(failedOutcome())
      // rollback re-syncs (op 1 then op 0, reverse order)
      .mockResolvedValueOnce(okOutcome())
      .mockResolvedValueOnce(okOutcome());

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
        { type: 'config-file-sync', configFileId: 'cf-2' },
      ],
      rollbackOnFailure: true,
      actor: baseActor(),
    });

    expect(result.status).toBe('rolled_back');
    expect(result.operations.map((o) => o.status)).toEqual(['rolled_back', 'rolled_back', 'failed']);

    // Restored content was written byte-for-byte (back to the snapshot).
    const restoreUpdates = mockPrisma.configFile.update.mock.calls;
    // cf-1 restored first (reverse order: succeededOps were [0,1]).
    expect(restoreUpdates[0][0]).toEqual({
      where: { id: 'cf-1' },
      data: { content: 'prev-1', isBinary: false },
    });
    expect(restoreUpdates[1][0]).toEqual({
      where: { id: 'cf-0' },
      data: { content: 'prev-0', isBinary: false },
    });

    // Forward pass + rollback re-sync calls: 3 forward + 2 rollback = 5.
    expect(syncConfigFileToAttachedServices).toHaveBeenCalledTimes(5);
  });

  it('rollbackOnFailure=true: ops after the failure are marked skipped (never attempted)', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-1', content: 'B', isBinary: false, name: 'b' },
      { id: 'cf-2', environmentId: 'env-1', content: 'C', isBinary: false, name: 'c' },
    ]);
    mockBatchCreate({
      opCount: 3,
      ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-1' }, { configFileId: 'cf-2' }],
    });
    // Op 0 fails immediately → ops 1 and 2 should never be attempted.
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce(failedOutcome());

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
        { type: 'config-file-sync', configFileId: 'cf-2' },
      ],
      rollbackOnFailure: true,
      actor: baseActor(),
    });

    expect(result.operations.map((o) => o.status)).toEqual(['failed', 'skipped', 'skipped']);
    // Nothing to roll back (no successful ops), so status is rolled_back (no rollback failures).
    expect(result.status).toBe('rolled_back');
    // syncConfigFileToAttachedServices called exactly once (the failing op).
    expect(syncConfigFileToAttachedServices).toHaveBeenCalledTimes(1);
  });

  it('rollbackOnFailure=false: continues past failure and returns partial', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-1', content: 'B', isBinary: false, name: 'b' },
      { id: 'cf-2', environmentId: 'env-1', content: 'C', isBinary: false, name: 'c' },
    ]);
    mockBatchCreate({
      opCount: 3,
      ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-1' }, { configFileId: 'cf-2' }],
    });
    vi.mocked(syncConfigFileToAttachedServices)
      .mockResolvedValueOnce(okOutcome())
      .mockResolvedValueOnce(failedOutcome())
      .mockResolvedValueOnce(okOutcome());

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
        { type: 'config-file-sync', configFileId: 'cf-2' },
      ],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.status).toBe('partial');
    expect(result.operations.map((o) => o.status)).toEqual(['ok', 'failed', 'ok']);
    // Every op attempted (no break on failure).
    expect(syncConfigFileToAttachedServices).toHaveBeenCalledTimes(3);
    // Restore should NEVER be called when rollbackOnFailure=false.
    expect(mockPrisma.configFile.update).not.toHaveBeenCalled();
  });

  it('rollbackOnFailure=false with all failures → batch status failed', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-1', content: 'B', isBinary: false, name: 'b' },
    ]);
    mockBatchCreate({ opCount: 2, ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-1' }] });
    vi.mocked(syncConfigFileToAttachedServices)
      .mockResolvedValueOnce(failedOutcome())
      .mockResolvedValueOnce(failedOutcome());

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
      ],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.status).toBe('failed');
    expect(result.operations.map((o) => o.status)).toEqual(['failed', 'failed']);
  });

  it('rollbackOnFailure=false with all ok → batch status ok', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce(okOutcome());

    const result = await executeBatch({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.status).toBe('ok');
  });

  it('unknown configFileId → op marked failed; rollbackOnFailure=true triggers rollback of prior ops', async () => {
    // Only cf-0 resolves; cf-missing isn't in the preload set → NOT_FOUND.
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'prev-0', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({
      opCount: 2,
      ops: [{ configFileId: 'cf-0' }, { configFileId: 'cf-missing' }],
    });
    vi.mocked(syncConfigFileToAttachedServices)
      .mockResolvedValueOnce(okOutcome()) // op 0 succeeds
      .mockResolvedValueOnce(okOutcome()); // rollback re-sync of op 0

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-missing' },
      ],
      rollbackOnFailure: true,
      actor: baseActor(),
    });

    expect(result.operations[1].status).toBe('failed');
    expect(result.operations[1].error?.code).toBe('NOT_FOUND');
    expect(result.operations[0].status).toBe('rolled_back');
    expect(result.status).toBe('rolled_back');
  });

  it('mixed-environment ops → batch fails fast with status=failed and all ops failed', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-A', content: 'A', isBinary: false, name: 'a' },
      { id: 'cf-1', environmentId: 'env-B', content: 'B', isBinary: false, name: 'b' },
    ]);
    // persistRejectedBatch path: a single syncBatch.create call with already-failed
    // status (no per-op updates).
    mockPrisma.syncBatch.create.mockResolvedValue({
      id: 'batch-mixed',
      status: 'failed',
      operations: [
        {
          index: 0,
          status: 'failed',
          error: JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Batch spans multiple environments' }),
        },
        {
          index: 1,
          status: 'failed',
          error: JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Batch spans multiple environments' }),
        },
      ],
    });

    const result = await executeBatch({
      operations: [
        { type: 'config-file-sync', configFileId: 'cf-0' },
        { type: 'config-file-sync', configFileId: 'cf-1' },
      ],
      rollbackOnFailure: true,
      actor: baseActor(),
    });

    expect(result.status).toBe('failed');
    expect(result.operations.every((o) => o.status === 'failed')).toBe(true);
    expect(result.operations[0].error?.code).toBe('VALIDATION_ERROR');
    // No sync attempts were made — we bailed before the forward loop.
    expect(syncConfigFileToAttachedServices).not.toHaveBeenCalled();
  });

  it('no_targets outcome counts as a per-op failure (silent-success guard)', async () => {
    // Per the implementation: any non-`ok` outcome is treated as a failure for
    // batch accounting (including no_targets and partial — issue #127 context).
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce({
      status: 'no_targets',
      success: false,
      results: [],
      targetsAttempted: 0,
      targetsSucceeded: 0,
      targetsFailed: 0,
      configFileName: 'a',
      environmentId: 'env-1',
    });

    const result = await executeBatch({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.operations[0].status).toBe('failed');
    expect(result.operations[0].error?.code).toBe('NO_TARGETS');
    expect(result.status).toBe('failed');
  });

  it('audit log is written with batchId backfilled for each completed op', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ id: 'batch-audit', opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce(okOutcome());

    // Audit backfill: simulate finding the audit row we just wrote.
    mockPrisma.auditLog.findFirst.mockResolvedValue({ id: 'audit-row-1' });

    await executeBatch({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    // logAudit was called with details including the batchId.
    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(logAudit).mock.calls[0][0];
    expect(auditCall.action).toBe('sync_files');
    expect(auditCall.resourceType).toBe('config_file');
    expect(auditCall.resourceId).toBe('cf-0');
    const details = auditCall.details as Record<string, unknown>;
    expect(details.batchId).toBe('batch-audit');

    // The backfill step ran: update the located audit row with the batchId column.
    expect(mockPrisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: 'audit-row-1' },
      data: { batchId: 'batch-audit' },
    });
  });

  it('helper that throws is caught and surfaced as a per-op INTERNAL failure', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockRejectedValueOnce(new Error('helper boom'));

    const result = await executeBatch({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.operations[0].status).toBe('failed');
    expect(result.operations[0].error?.code).toBe('INTERNAL');
    expect(result.operations[0].error?.message).toBe('helper boom');
  });

  it('helper returning null (config file vanished between preload and run) → failed NOT_FOUND', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce(null as unknown as ReturnType<typeof okOutcome>);

    const result = await executeBatch({
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: false,
      actor: baseActor(),
    });

    expect(result.operations[0].status).toBe('failed');
    expect(result.operations[0].error?.code).toBe('NOT_FOUND');
  });

  it('passes idempotencyKey and idempotencyBodyHash through to the persisted row', async () => {
    mockPrisma.configFile.findMany.mockResolvedValue([
      { id: 'cf-0', environmentId: 'env-1', content: 'A', isBinary: false, name: 'a' },
    ]);
    mockBatchCreate({ opCount: 1, ops: [{ configFileId: 'cf-0' }] });
    vi.mocked(syncConfigFileToAttachedServices).mockResolvedValueOnce(okOutcome());

    const input: BatchExecuteInput = {
      operations: [{ type: 'config-file-sync', configFileId: 'cf-0' }],
      rollbackOnFailure: true,
      actor: baseActor(),
      idempotencyKey: 'key-X',
      idempotencyBodyHash: 'hash-X',
    };
    await executeBatch(input);

    const createCall = mockPrisma.syncBatch.create.mock.calls[0][0];
    expect(createCall.data.idempotencyKey).toBe('key-X');
    expect(createCall.data.idempotencyBodyHash).toBe('hash-X');
    expect(createCall.data.userId).toBe('user-1');
    expect(createCall.data.apiTokenId).toBe('tok-1');
    expect(createCall.data.environmentId).toBe('env-1');
  });
});
