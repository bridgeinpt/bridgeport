/**
 * Global error handler + onSend reshaping for the BRIDGEPORT API.
 *
 * Goals:
 *
 *  1. Convert every thrown error (ApiError, Zod, Fastify validation, native
 *     Error) into the canonical envelope: `{code, message, field?, hint?, requestId}`.
 *
 *  2. Reshape *legacy* `reply.code(...).send({error: "..."})` bodies into
 *     the same envelope via an `onSend` hook, so we don't have to touch
 *     every route at once. If a route already returns a body with a
 *     `code` field, the hook is a no-op (idempotent).
 *
 *  3. Hide internal 5xx messages from clients — the original error is
 *     still logged + captured by Sentry, but the wire response says
 *     "Internal Server Error" so we don't leak stack-trace fragments.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { ApiError, codeForStatus, type ErrorEnvelope } from '../lib/errors.js';
import { isTransientDbError } from '../lib/db-retry.js';
import { captureException } from '../lib/sentry.js';

type AnyError = Error & {
  statusCode?: number;
  validation?: unknown[];
  code?: string;
};

function envelopeFromZod(err: ZodError): ErrorEnvelope {
  const first = err.issues[0];
  const fieldPath = first?.path?.length ? first.path.join('.') : undefined;
  return {
    code: 'VALIDATION_ERROR',
    message: first?.message ?? 'Invalid input',
    ...(fieldPath ? { field: fieldPath } : {}),
  };
}

function envelopeFromFastifyValidation(err: AnyError): ErrorEnvelope {
  // Fastify validation errors carry `validation` (an array of AJV errors).
  // We surface the first one's message and path for `field`.
  const first = Array.isArray(err.validation) ? (err.validation[0] as Record<string, unknown> | undefined) : undefined;
  const instancePath = typeof first?.instancePath === 'string' ? first.instancePath : '';
  const field = instancePath.startsWith('/') ? instancePath.slice(1).replace(/\//g, '.') : undefined;
  return {
    code: 'VALIDATION_ERROR',
    message: err.message || 'Invalid input',
    ...(field ? { field } : {}),
  };
}

function buildEnvelope(err: AnyError): { envelope: ErrorEnvelope; statusCode: number } {
  if (err instanceof ApiError) {
    // 5xx: hide the original message to avoid leaking internals. The full
    // error is still logged + sent to Sentry by the surrounding handler.
    const message = err.statusCode >= 500 ? 'Internal Server Error' : err.message;
    return {
      envelope: {
        code: err.code,
        message,
        ...(err.field !== undefined ? { field: err.field } : {}),
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
      },
      statusCode: err.statusCode,
    };
  }

  if (err instanceof ZodError) {
    return { envelope: envelopeFromZod(err), statusCode: 400 };
  }

  // Fastify validation errors are plain Errors with statusCode === 400 and
  // a `validation` array. They are NOT instances of ZodError.
  if (Array.isArray(err.validation)) {
    return {
      envelope: envelopeFromFastifyValidation(err),
      statusCode: err.statusCode ?? 400,
    };
  }

  // Transient SQLite contention (issue #299): another writer held the lock
  // past busy_timeout, or a SQLITE_BUSY_SNAPSHOT fired. The DB-retry extension
  // already retried with backoff, so reaching here means the contention
  // outlasted the retry budget. Surface a retryable 503 (not an opaque 500) so
  // clients — and the Terraform provider's acceptance suite — back off and
  // retry instead of failing. Only reached for raw/uncaught Prisma errors;
  // intentional ApiError(SERVICE_UNAVAILABLE) is handled by the branch above.
  if (isTransientDbError(err)) {
    return {
      envelope: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily busy. Please retry.',
        hint: 'Retry the request after a short delay.',
      },
      statusCode: 503,
    };
  }

  // Rate-limit plugin throws an Error with statusCode 429 and a code of 'FST_ERR_RATE_LIMIT'.
  const status = err.statusCode ?? 500;
  const code = codeForStatus(status);

  // 5xx: hide the internal message to avoid leaking stack fragments.
  const message = status >= 500 ? 'Internal Server Error' : err.message || 'Error';
  return {
    envelope: { code, message },
    statusCode: status,
  };
}

function isAlreadyEnvelope(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return typeof obj.code === 'string' && typeof obj.message === 'string';
}

function isLegacyErrorShape(body: unknown): body is { error: string; [k: string]: unknown } {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return typeof obj.error === 'string' && typeof obj.code !== 'string';
}

async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: AnyError, request: FastifyRequest, reply: FastifyReply) => {
    const { envelope, statusCode } = buildEnvelope(error);

    if (statusCode === 503 && envelope.code === 'SERVICE_UNAVAILABLE') {
      // Transient contention (issue #299): expected, retryable backpressure —
      // not a code bug. Log it (so it is no longer invisible — the original
      // report saw 500s with no level:50 line) but at WARN, and skip Sentry to
      // avoid alert noise on every lock blip. Advertise a 1s Retry-After.
      request.log.warn({ err: error, statusCode }, 'Transient database contention; returning 503');
      reply.header('Retry-After', '1');
    } else if (statusCode >= 500) {
      // Log the *original* error (with stack) before we hide it from the wire.
      request.log.error({ err: error, statusCode }, 'Unhandled error');
      captureException(error, {
        method: request.method,
        url: request.url,
        statusCode,
        requestId: request.id,
      });
    }

    const body: ErrorEnvelope = {
      ...envelope,
      ...(request.id ? { requestId: String(request.id) } : {}),
    };

    reply.code(statusCode).send(body);
  });

  // Reshape legacy `{error: "..."}` bodies into the canonical envelope.
  // Runs for every reply; cheap early-outs for the common case.
  fastify.addHook('onSend', async (request, reply, payload) => {
    const status = reply.statusCode;
    if (status < 400) return payload;

    // Only touch JSON.
    const contentType = reply.getHeader('content-type');
    const ct = Array.isArray(contentType) ? contentType[0] : contentType;
    if (typeof ct !== 'string' || !ct.includes('application/json')) {
      return payload;
    }

    // The payload reaching onSend is typically the JSON string Fastify
    // produced from the handler's return value / reply.send() body.
    if (typeof payload !== 'string') return payload;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return payload;
    }

    // Already in the envelope shape — leave alone (idempotent).
    if (isAlreadyEnvelope(parsed)) {
      // But still ensure requestId is present.
      const obj = parsed as Record<string, unknown>;
      if (!obj.requestId && request.id) {
        const next = { ...obj, requestId: String(request.id) };
        return JSON.stringify(next);
      }
      return payload;
    }

    if (!isLegacyErrorShape(parsed)) {
      // Not a recognized error body; leave alone.
      return payload;
    }

    const code = codeForStatus(status);
    const legacy = parsed as { error: string; details?: unknown; message?: string };
    const message = status >= 500 ? 'Internal Server Error' : legacy.error;
    const envelope: ErrorEnvelope & { details?: unknown } = {
      code,
      message,
      ...(request.id ? { requestId: String(request.id) } : {}),
    };
    // Preserve legacy `details` array (used by validation errors) as a
    // non-standard but harmless field — clients that branch on `code`
    // will continue to work, and existing UIs that read `details` still see them.
    // For 5xx we drop it: legacy routes may stuff stack-trace fragments or
    // internal debug info in there, and we already mask `message`.
    if (legacy.details !== undefined && status < 500) envelope.details = legacy.details;

    return JSON.stringify(envelope);
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});
