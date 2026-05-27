/**
 * Standardized API error envelope and error codes.
 *
 * Every non-2xx response from the BRIDGEPORT API follows this shape:
 *
 *   { code, message, field?, hint?, requestId? }
 *
 * `code` is one of the values in `ErrorCode` so programmatic clients can
 * branch on a stable enum instead of brittle HTTP-status checks or
 * message substrings.
 *
 * Routes throw `new ApiError(code, message, { field, hint, statusCode })`
 * and the global error handler (`src/plugins/error-handler.ts`) converts
 * it into the wire envelope.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'READONLY_FIELD',
  'UNAUTHORIZED',
  'FORBIDDEN_SCOPE',
  'FORBIDDEN_ROLE',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Default HTTP status for each ErrorCode. ApiError callers may override
 * via the `statusCode` option (e.g. a route that wants to return 422 for
 * a validation error while keeping the VALIDATION_ERROR code).
 */
const DEFAULT_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  // 422 Unprocessable Entity: request was syntactically valid but contained
  // semantically invalid input (a read-only/derived field). See issue #127.
  READONLY_FIELD: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN_SCOPE: 403,
  FORBIDDEN_ROLE: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function statusForCode(code: ErrorCode): number {
  return DEFAULT_STATUS_BY_CODE[code];
}

/**
 * Inverse mapping used by the onSend hook when reshaping legacy
 * `{error: "..."}` bodies that don't yet carry a `code`. Falls back to
 * INTERNAL for anything we don't recognize.
 */
export function codeForStatus(status: number): ErrorCode {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN_SCOPE';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  // 4xx that we don't have a specific mapping for — treat as validation.
  if (status >= 400) return 'VALIDATION_ERROR';
  return 'INTERNAL';
}

export interface ApiErrorOptions {
  /** Field name (e.g. "password") for validation/readonly errors. */
  field?: string;
  /** Optional human-friendly hint for resolving the error. */
  hint?: string;
  /** Override the default HTTP status for the code. */
  statusCode?: number;
  /** Optional underlying cause; preserved for logs/Sentry, not sent to the client. */
  cause?: unknown;
}

/**
 * Error thrown from routes/services that should be surfaced to the
 * client as a structured envelope. The Fastify error handler catches
 * these and writes `{code, message, field?, hint?, requestId}`.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly field?: string;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = options.statusCode ?? statusForCode(code);
    this.field = options.field;
    this.hint = options.hint;
    if (options.cause !== undefined) {
      // Node Error supports `cause` natively; cast to keep TS happy without
      // requiring lib lib upgrade.
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Wire envelope returned to clients for any non-2xx response.
 *
 * `requestId` is filled in by the error handler from `request.id` so
 * support can correlate a client-side failure back to server logs.
 */
export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  field?: string;
  hint?: string;
  requestId?: string;
}

/**
 * Build an envelope from an ApiError (no requestId — the handler adds it).
 */
export function envelopeFromApiError(err: ApiError): ErrorEnvelope {
  const env: ErrorEnvelope = {
    code: err.code,
    message: err.message,
  };
  if (err.field !== undefined) env.field = err.field;
  if (err.hint !== undefined) env.hint = err.hint;
  return env;
}
