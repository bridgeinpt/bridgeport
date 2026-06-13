/**
 * `injectApi` — replays a tool's request against the internal HTTP API via
 * `app.inject()` (issue #208).
 *
 * This is the single mechanism the whole MCP server rests on: by issuing a real
 * internal request that carries the MCP caller's bearer token, auth, per-route
 * role/scope enforcement, Zod validation, the global Idempotency-Key middleware
 * (#126), and audit logging all run EXACTLY as they would for an external REST
 * call. No business logic is duplicated.
 *
 * Header policy: we forward ONLY `authorization` (the caller's bearer) and, for
 * writes, `Idempotency-Key`. Client cookies, Origin, and arbitrary headers are
 * never forwarded — the injected request must not be able to smuggle a session
 * cookie or spoof an origin, and the credential scoping for idempotency keys
 * folds in the Authorization header, so a stray Cookie could change keying.
 */

import type { FastifyInstance } from 'fastify';
import { safeJsonParse } from '../lib/helpers.js';
import type { ErrorCode } from '../lib/errors.js';

export interface InjectApiOptions {
  method: 'GET' | 'POST';
  url: string;
  /** Raw bearer token (without "Bearer " prefix) of the MCP caller. */
  bearer: string;
  /** When set (write tools), forwarded as the Idempotency-Key header. */
  idempotencyKey?: string;
  /** JSON body for POST requests. */
  body?: Record<string, unknown>;
}

/** Canonical API error envelope shape (subset we surface to MCP). */
export interface ApiErrorEnvelope {
  code: ErrorCode | string;
  message: string;
  field?: string;
  hint?: string;
}

export interface InjectApiResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body (or the raw string if it wasn't JSON, or null if empty). */
  body: unknown;
  /** Populated on a non-2xx response when the body matched the canonical envelope. */
  error?: ApiErrorEnvelope;
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).message === 'string'
  );
}

/**
 * Issue an internal API request on behalf of the MCP caller and normalize the
 * response. Never throws for a non-2xx API response — the caller maps
 * `result.ok === false` (and `result.error`) into an MCP error result.
 */
export async function injectApi(
  app: FastifyInstance,
  options: InjectApiOptions
): Promise<InjectApiResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.bearer}`,
  };
  if (options.idempotencyKey) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  // Only set a JSON content-type when there is a body. The custom content-type
  // parser treats an empty body as `{}`, so GETs need no content-type.
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    // light-my-request accepts an object payload and serializes it; we pass the
    // raw object so the JSON content-type parser and idempotency body-hash see
    // the same canonical serialization a REST client would send.
    payload: options.body,
  });

  const raw = response.payload;
  const parsed = raw && raw.length > 0 ? safeJsonParse<unknown>(raw, raw) : null;
  const ok = response.statusCode >= 200 && response.statusCode < 300;

  const result: InjectApiResult = {
    status: response.statusCode,
    ok,
    body: parsed,
  };

  if (!ok && isErrorEnvelope(parsed)) {
    result.error = parsed;
  }

  return result;
}
