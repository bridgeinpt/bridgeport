/**
 * Atomic multi-resource sync batch endpoints (issue #130).
 *
 * - POST /api/sync/batch
 *     Body: { operations: [{type:"config-file-sync", configFileId}], rollbackOnFailure }
 *     Header: Idempotency-Key (optional)
 *     Response: { batchId, status, operations:[{index, status, error?}] }
 *
 * - GET /api/sync/batch/:batchId
 *     Replays the persisted batch + ops for inspection.
 *
 * v1 only supports `config-file-sync` ops; other op types are rejected at
 * validation time. See `src/services/sync-batch.ts` for the execution model.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { actorFrom } from '../services/audit.js';
import { ApiError } from '../lib/errors.js';
import { validateBody } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';
import {
  executeBatch,
  hashCanonicalBody,
  lookupIdempotentBatch,
  IdempotencyKeyConflictError,
  batchRowToResult,
} from '../services/sync-batch.js';

const operationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('config-file-sync'),
    configFileId: z.string().min(1),
  }),
  // Reject unknown op types loudly with VALIDATION_ERROR.
]);

const batchBodySchema = z.object({
  operations: z.array(operationSchema).min(1, 'At least one operation is required').max(50),
  rollbackOnFailure: z.boolean().default(true),
});

const batchIdParamsSchema = z.object({ batchId: z.string() });

/** Trim & sanity-check an Idempotency-Key header. */
function readIdempotencyKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Cap key length to defend against header abuse. 200 chars is more than
  // enough for any UUID / opaque token a client would pass.
  if (trimmed.length > 200) {
    throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key header is too long', {
      field: 'Idempotency-Key',
    });
  }
  return trimmed;
}

export async function syncBatchRoutes(fastify: FastifyInstance): Promise<void> {
  // Execute (or replay) a transactional batch of config-file syncs.
  fastify.post(
    '/api/sync/batch',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Execute (or replay) a transactional batch of config-file syncs',
        body: batchBodySchema,
        errors: [400, 401, 403, 409],
      }),
    },
    async (request, reply) => {
      const body = validateBody(batchBodySchema, request, reply);
      if (!body) return;

      const idempotencyKey = readIdempotencyKey(
        // Fastify lowercases header names by default.
        request.headers['idempotency-key']
      );

      const bodyHash = hashCanonicalBody(body);

      // Idempotency replay: same key + same body → return the cached result.
      // Same key + different body → 409 CONFLICT (we never re-execute).
      if (idempotencyKey) {
        try {
          const replay = await lookupIdempotentBatch(idempotencyKey, bodyHash);
          if (replay) {
            return replay;
          }
        } catch (err) {
          if (err instanceof IdempotencyKeyConflictError) {
            throw new ApiError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used with a different request body',
              { field: 'Idempotency-Key' }
            );
          }
          throw err;
        }
      }

      const result = await executeBatch({
        operations: body.operations,
        rollbackOnFailure: body.rollbackOnFailure,
        actor: actorFrom(request),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(idempotencyKey ? { idempotencyBodyHash: bodyHash } : {}),
      });

      return result;
    }
  );

  // Fetch a persisted batch + its ops.
  //
  // Gated on requireOperator (operator-or-admin) AND env-scope: an env-scoped
  // API token can only read a batch whose `environmentId` is in its allowed
  // envs. We return 404 (not 403) for forbidden access so existence isn't
  // leaked. JWT-session users — who currently aren't env-scoped — bypass the
  // env check by design.
  fastify.get(
    '/api/sync/batch/:batchId',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Fetch a persisted sync batch and its operations',
        params: batchIdParamsSchema,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { batchId } = request.params as { batchId: string };

      const row = await prisma.syncBatch.findUnique({
        where: { id: batchId },
        include: { operations: { orderBy: { index: 'asc' } } },
      });

      if (!row) {
        return reply.code(404).send({ error: 'Sync batch not found' });
      }

      const scope = request.authUser?.scope;
      if (scope && !scope.allEnvironments) {
        const allowed = row.environmentId
          ? scope.environmentIds.includes(row.environmentId)
          : false;
        if (!allowed) {
          return reply.code(404).send({ error: 'Sync batch not found' });
        }
      }

      return batchRowToResult(row);
    }
  );
}
