/**
 * Idempotency-Key support for mutating POSTs (issue #126).
 *
 * Registered as a Fastify plugin AFTER the authenticate decorator so the env
 * scope (`request.authUser`) is known. It engages ONLY when a request is a POST
 * carrying an `Idempotency-Key` header — every other request passes straight
 * through, so the feature naturally covers /deployments,
 * /deployment-plans/:id/execute, /backups/:id/run, /servers, etc. without any
 * per-route wiring.
 *
 * Contract:
 *   - First time a (key, method, routerPath) is seen → an IdempotencyKey row is
 *     created (inProgress=true, expiresAt = now + 24h). The handler runs, and an
 *     onSend hook persists the response (2xx) or deletes the row (non-2xx, so a
 *     retry can proceed).
 *   - A replay with the SAME body whose stored response exists → the handler is
 *     SKIPPED and the cached response is returned verbatim (no second deploy).
 *   - A replay with the SAME body still inProgress (a concurrent retry) → 409.
 *   - A replay with a DIFFERENT body → 409 IDEMPOTENCY_KEY_REUSED.
 *
 * The `@@unique([key, method, path])` constraint is used to win create races:
 * a P2002 on insert means another request beat us to it, so we treat it as a
 * replay.
 *
 * Determinism note: `requestHash` is the SHA-256 of `JSON.stringify(request.body)`.
 * This is order-sensitive (two bodies with the same keys in a different order
 * hash differently), which is acceptable — clients retrying a request resend the
 * identical serialized body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { ApiError } from './errors.js';

/** How long a stored idempotency result is honored before it expires. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Routes that run their OWN idempotency handling and must NOT be double-handled
 * by this global hook. `/api/sync/batch` (issue #130) has bespoke
 * Idempotency-Key logic backed by the SyncBatch model.
 */
const IDEMPOTENCY_EXEMPT_PATHS = new Set<string>(['/api/sync/batch']);

// Marker stashed on the request when this request created a fresh row. The
// SYNCHRONOUS onSend hook captures the outgoing response onto it; the async
// onResponse hook then persists/cleans up the row. Kept off the public
// FastifyRequest type via a symbol-keyed property.
//
// Why split across two hooks: the global error-handler registers a
// payload-REWRITING onSend hook. A second onSend hook that defers (returns a
// Promise / calls its callback on a later tick) after that rewrite triggers a
// double `writeHead` under light-my-request (ERR_HTTP_HEADERS_SENT). So our
// onSend must be strictly synchronous and never modify the payload; the DB
// write happens in onResponse, which runs after the response is already sent
// and therefore cannot double-write headers.
const FRESH_KEY = Symbol('idempotencyFreshRow');

interface FreshRowMarker {
  rowId: string;
  key: string;
  // Filled in by the synchronous onSend capture step.
  captured?: boolean;
  responseStatus?: number;
  responseBody?: string | null;
}

function getFreshMarker(request: FastifyRequest): FreshRowMarker | undefined {
  return (request as unknown as Record<symbol, FreshRowMarker | undefined>)[FRESH_KEY];
}

function setFreshMarker(request: FastifyRequest, marker: FreshRowMarker): void {
  (request as unknown as Record<symbol, FreshRowMarker | undefined>)[FRESH_KEY] = marker;
}

/** Read + sanity-check the Idempotency-Key header. Returns undefined if absent. */
function readKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Cap length to defend against header abuse.
  if (trimmed.length > 200) {
    throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key header is too long', {
      field: 'Idempotency-Key',
    });
  }
  return trimmed;
}

/**
 * Hash the request body deterministically. Returns null when the body is not a
 * plain JSON object — multipart/file uploads (e.g. POST /services/:id/files)
 * arrive as a stream/parts and have no stable JSON body, so we skip idempotency
 * for them gracefully rather than crash.
 */
function hashBody(body: unknown): string | null {
  if (body === undefined || body === null) {
    // An empty JSON body is valid and deterministic (the JSON parser yields {}).
    return createHash('sha256').update('null').digest('hex');
  }
  if (typeof body !== 'object' || Buffer.isBuffer(body)) {
    // Non-object body (e.g. raw buffer from multipart) — not hashable as JSON.
    return null;
  }
  try {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  } catch {
    // Circular structure or non-serializable — skip idempotency gracefully.
    return null;
  }
}

/** Resolve the env id (if any) the request targets, for attribution only. */
function resolveEnvironmentId(request: FastifyRequest): string | null {
  const params = (request.params ?? {}) as Record<string, string>;
  return params.envId ?? params.id ?? null;
}

async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method.toUpperCase() !== 'POST') return;

  const routerPath = request.routeOptions?.url ?? request.url;
  if (IDEMPOTENCY_EXEMPT_PATHS.has(routerPath)) return;

  const key = readKey(request);
  if (!key) return;

  const requestHash = hashBody(request.body);
  // Non-JSON body (multipart upload, etc.) — skip idempotency gracefully.
  if (requestHash === null) return;

  const existing = await prisma.idempotencyKey.findUnique({
    where: { key_method_path: { key, method: 'POST', path: routerPath } },
  });

  if (existing && existing.expiresAt > new Date()) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
        { field: 'Idempotency-Key' }
      );
    }
    if (existing.inProgress) {
      // A concurrent request with the same key+body is still running.
      throw new ApiError(
        'CONFLICT',
        'A request with this Idempotency-Key is still in progress',
        { field: 'Idempotency-Key', hint: 'Retry once the original request completes.' }
      );
    }
    // Replay: short-circuit with the stored response. The handler does NOT run.
    reply
      .code(existing.responseStatus ?? 200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('idempotent-replayed', 'true')
      .send(existing.responseBody ?? '{}');
    return;
  }

  // No live row — create one. Use the unique constraint to win races: a P2002
  // means another request inserted first, so treat this as a concurrent replay.
  try {
    const row = await prisma.idempotencyKey.create({
      data: {
        key,
        method: 'POST',
        path: routerPath,
        requestHash,
        environmentId: resolveEnvironmentId(request),
        inProgress: true,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
      },
    });
    setFreshMarker(request, { rowId: row.id, key });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost the race. A row now exists (possibly with a stale expiresAt if the
      // prior one was expired but not yet replaced). Treat as in-progress
      // concurrent retry — the client should retry shortly.
      throw new ApiError(
        'CONFLICT',
        'A request with this Idempotency-Key is being processed concurrently',
        { field: 'Idempotency-Key', hint: 'Retry shortly.' }
      );
    }
    throw err;
  }
}

/**
 * SYNCHRONOUS capture of the outgoing response. Uses the callback (`done`) hook
 * form on purpose: it MUST resolve on the same tick and MUST NOT modify the
 * payload — see the FRESH_KEY comment for why (a deferring onSend after the
 * error-handler's payload-rewriting onSend double-writes headers under
 * light-my-request). The actual DB write happens later in onResponse.
 *
 * NOTE: the 4-arg `done` signature is required. A 3-arg onSend that returns a
 * plain (non-Promise) value stalls Fastify's onSend runner, which waits for a
 * thenable that never arrives — hanging every response.
 */
function captureOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (err: Error | null, payload?: unknown) => void
): void {
  const marker = getFreshMarker(request);
  if (marker && !marker.captured) {
    marker.captured = true;
    marker.responseStatus = reply.statusCode;
    marker.responseBody = typeof payload === 'string' ? payload : null;
  }
  done(null, payload);
}

/**
 * Finalize the idempotency row after the response has been sent. Runs in
 * onResponse so the async DB write can never interfere with header writing.
 * A 2xx response is persisted (so a replay short-circuits); any other status
 * deletes the row so the client can retry the same key.
 */
async function finalizeOnResponse(request: FastifyRequest): Promise<void> {
  const marker = getFreshMarker(request);
  if (!marker || !marker.captured) return;
  // Run exactly once.
  setFreshMarkerConsumed(request);

  const status = marker.responseStatus ?? 0;

  try {
    if (status >= 200 && status < 300) {
      await prisma.idempotencyKey.update({
        where: { id: marker.rowId },
        data: {
          inProgress: false,
          responseStatus: status,
          responseBody: marker.responseBody ?? null,
        },
      });
    } else {
      // Non-2xx — delete the row so the client can retry with the same key.
      await prisma.idempotencyKey.delete({ where: { id: marker.rowId } }).catch(() => {});
    }
  } catch (err) {
    // Never let idempotency bookkeeping break anything.
    console.error('[Idempotency] failed to finalize key row:', err);
  }
}

// Clear the marker so finalize runs a single time per request.
function setFreshMarkerConsumed(request: FastifyRequest): void {
  (request as unknown as Record<symbol, FreshRowMarker | undefined>)[FRESH_KEY] = undefined;
}

async function idempotencyPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', preHandler);
  // onSend is strictly synchronous (capture only). onResponse does the DB write.
  fastify.addHook('onSend', captureOnSend);
  fastify.addHook('onResponse', finalizeOnResponse);
}

export default fp(idempotencyPlugin, {
  name: 'idempotency',
});

/**
 * Delete IdempotencyKey rows whose expiry has passed. Called from the
 * scheduler. Returns the deleted count.
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
