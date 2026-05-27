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
    return {
      envelope: {
        code: err.code,
        message: err.message,
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

    if (statusCode >= 500) {
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
    if (legacy.details !== undefined) envelope.details = legacy.details;

    return JSON.stringify(envelope);
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});
