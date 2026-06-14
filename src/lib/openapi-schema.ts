/**
 * DOCUMENTATION-ONLY route schema builder.
 *
 * This module wires the EXISTING Zod validation schemas (consumed by
 * `validateBody()` / `validateUpdateBody()`) into Fastify route `schema`
 * options so `/openapi.json` is typed from a single source of truth — no drift
 * between the runtime contract and the published spec.
 *
 * ── Critical design constraints ──────────────────────────────────────────────
 *
 * 1. RUNTIME VALIDATION IS UNCHANGED. The Zod schemas remain the validators via
 *    `validateBody()`/`validateUpdateBody()`. The JSON Schema produced here is
 *    attached to the route purely for the spec. We deliberately do NOT migrate
 *    validation into Fastify's pipeline, because that would bypass the
 *    readonly-field 422 logic and the custom error envelope.
 *
 * 2. NEVER CRASH REGISTRATION. `z.toJSONSchema()` (Zod 4.4.3) converts the vast
 *    majority of our schemas — including `.coerce`, `.default()`, and `.refine()`
 *    schemas (the refine *constraint* is silently dropped, but the base shape
 *    converts fine). It only THROWS on genuinely non-representable constructs
 *    such as `z.custom()`, or `.transform()` under OUTPUT semantics (the
 *    transform's INPUT view resolves to its source type, so `io: 'input'`
 *    converts a transform fine). Every conversion is wrapped in try/catch: on a
 *    real error we emit a non-fatal `console.warn` and omit that fragment rather
 *    than break route registration. Docs are best-effort, but failures are now
 *    VISIBLE during `openapi:dump`/CI.
 *
 *    INPUT vs OUTPUT semantics: request schemas (body/params/querystring) are
 *    converted with `io: 'input'`; response schemas with `io: 'output'`. This
 *    matters because the runtime validates with Zod `.parse()`, whose INPUT view
 *    of a strip-mode object (a) does NOT mark `.default()` fields as `required`
 *    (they're optional for the client) and (b) does NOT emit
 *    `additionalProperties: false` (unknown keys are stripped, not rejected).
 *    The default `io: 'output'` would mistype both. See Fix 1 / issue #198.
 *
 * 3. RESPONSE-SCHEMA TRUNCATION. Attaching a `response` schema activates
 *    `fast-json-stringify`, which DROPS any response key not declared in the
 *    schema. To avoid silently truncating live responses we only ever attach
 *    ERROR responses (a fixed, fully-modelled `ErrorEnvelope`) by default via
 *    `errors`, and require callers to opt in explicitly for success responses
 *    via `response` only when the schema is complete.
 */

import { z, type ZodType } from 'zod';
import type { FastifySchema } from 'fastify';
import { ERROR_ENVELOPE_SCHEMA_ID } from '../plugins/openapi.js';

/** HTTP status codes for which `errors` can attach an ErrorEnvelope response. */
export type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

/**
 * Shared, documentation-only query schemas for list endpoints.
 *
 * These describe the `limit`/`offset` pagination query params for the OpenAPI
 * spec only — there is NO runtime enforcement. The global no-op validator
 * compiler in `src/server.ts` makes all route `schema` options docs-only; the
 * handlers read pagination via `parsePaginationQuery()` themselves.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().min(0).optional(),
  offset: z.coerce.number().min(0).optional(),
});

/** Documentation-only query schema for endpoints that accept only `limit`. */
export const limitQuerySchema = z.object({
  limit: z.coerce.number().min(0).optional(),
});

export interface RouteSchemaOptions {
  tags?: string[];
  summary?: string;
  description?: string;
  /** Marks the whole operation as deprecated in the spec. */
  deprecated?: boolean;
  /** Zod schema for the JSON request body. */
  body?: ZodType;
  /** Zod schema for path params (`:id`, etc.). */
  params?: ZodType;
  /** Zod schema for the query string. */
  querystring?: ZodType;
  /**
   * Map of HTTP status → success response schema. ONLY attach when the schema
   * is COMPLETE or sets `additionalProperties: true`; an incomplete schema will
   * silently truncate live response keys (see module header note 3). When in
   * doubt, omit and let the route stay untyped on the response side.
   */
  response?: Record<number, ZodType | Record<string, unknown>>;
  /**
   * Error status codes to document. Each maps to the canonical ErrorEnvelope —
   * a fixed, fully-modelled shape, so declaring these never truncates anything.
   */
  errors?: ErrorStatusCode[];
}

const DEFAULT_ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Bad request — malformed input or failed validation.',
  401: 'Unauthorized — missing or invalid bearer token.',
  403: 'Forbidden — token scope or role does not permit this operation.',
  404: 'Not found.',
  409: 'Conflict — e.g. a unique constraint violation.',
  422: 'Unprocessable — e.g. a read-only field was supplied.',
  429: 'Rate limited — retry after the `Retry-After` interval.',
  500: 'Internal server error.',
};

/** Conversion direction for {@link zodToOpenApi}. See module header note 2. */
export type ConversionIo = 'input' | 'output';

/** Number.MAX_SAFE_INTEGER — the bogus UPPER bound Zod emits for a one-sided
 * `.int().min()/.positive()`. Its negative twin (MIN_SAFE_INTEGER) is the bogus
 * LOWER bound emitted for a one-sided `.int().max()`. Both are stripped by
 * {@link sanitizeConvertedSchema}. */
const MAX_SAFE_INTEGER_BOUND = 9007199254740991;
const MIN_SAFE_INTEGER_BOUND = -9007199254740991;

/**
 * Recursively clean a converted JSON Schema fragment IN PLACE, then return it.
 *
 * Two fixups, both of which make the spec faithful to the actual runtime
 * contract (issue #198):
 *
 *  1. Delete `additionalProperties` when it is exactly `false`. The runtime
 *     validates with Zod `.parse()` in the default STRIP mode — unknown keys are
 *     silently dropped, NOT rejected — so the wire contract is OPEN. None of our
 *     route schemas use `.strict()` (verified), so any `additionalProperties:
 *     false` Zod emits here is spurious. `additionalProperties: true` is left
 *     untouched (it's a deliberate "open object" marker).
 *  2. Delete a `maximum` of exactly Number.MAX_SAFE_INTEGER (and a paired
 *     `exclusiveMaximum`), and a `minimum` of exactly Number.MIN_SAFE_INTEGER
 *     (and a paired `exclusiveMinimum`) — these are garbage one-sided bounds Zod
 *     synthesizes for `.int().min()`/`.positive()` (bogus max) and `.int().max()`
 *     (bogus min). Removing them keeps the spec honest about genuinely unbounded
 *     fields.
 */
function sanitizeConvertedSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeConvertedSchema(item);
    return node;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;

    if (obj.additionalProperties === false) {
      delete obj.additionalProperties;
    }
    if (obj.maximum === MAX_SAFE_INTEGER_BOUND) {
      delete obj.maximum;
      // The `exclusiveMaximum` boolean (OpenAPI 3.0 form) only has meaning
      // alongside `maximum`; drop it too when we strip the bogus bound.
      if (typeof obj.exclusiveMaximum === 'boolean') delete obj.exclusiveMaximum;
    }
    if (obj.minimum === MIN_SAFE_INTEGER_BOUND) {
      delete obj.minimum;
      if (typeof obj.exclusiveMinimum === 'boolean') delete obj.exclusiveMinimum;
    }

    for (const value of Object.values(obj)) sanitizeConvertedSchema(value);
  }
  return node;
}

/**
 * Convert a Zod schema to OpenAPI 3.0 JSON Schema. Returns `undefined` on a
 * genuine conversion error (e.g. `.transform()`, which has no JSON Schema
 * representation) so callers can omit the fragment without crashing route
 * registration. Failures emit a non-fatal `console.warn` so a silently
 * unconvertible schema is visible during `openapi:dump`/CI.
 *
 * `io` selects INPUT vs OUTPUT semantics (default `'output'`). Request schemas
 * (body/params/querystring) MUST pass `'input'` — see module header note 2.
 *
 * We target `openapi-3.0` to match the plugin's `openapi: '3.0.3'` (avoids
 * draft-2020-12 keywords like `prefixItems` that an OpenAPI 3.0 validator would
 * reject). The result is post-processed by {@link sanitizeConvertedSchema}.
 */
export function zodToOpenApi(
  schema: ZodType,
  io: ConversionIo = 'output'
): Record<string, unknown> | undefined {
  // Guard a programming error (a forgotten/undefined schema arg) distinctly
  // from a normal "not representable" miss.
  if (!schema) {
    // eslint-disable-next-line no-console
    console.warn('[openapi] zodToOpenApi called with a falsy schema argument (programming error)');
    return undefined;
  }
  try {
    const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as Record<string, unknown>;
    return sanitizeConvertedSchema(json) as Record<string, unknown>;
  } catch (err) {
    // A non-representable schema (transform, etc.) is omitted from the spec.
    // Validation is unaffected (still done by Zod). Warn so it's not invisible.
    // eslint-disable-next-line no-console
    console.warn(
      `[openapi] zodToOpenApi conversion failed (io=${io}); omitting fragment: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return undefined;
  }
}

/** Build the OpenAPI response object referencing the shared ErrorEnvelope. */
function errorEnvelopeResponse(code: number): Record<string, unknown> {
  return {
    description: DEFAULT_ERROR_DESCRIPTIONS[code] ?? 'Error envelope.',
    content: {
      'application/json': {
        // `ErrorEnvelope#` resolves against the shared schema registered in
        // src/plugins/openapi.ts → emitted as `#/components/schemas/ErrorEnvelope`.
        schema: { $ref: `${ERROR_ENVELOPE_SCHEMA_ID}#` },
      },
    },
  };
}

/**
 * Build a Fastify `schema` fragment from existing Zod consts plus metadata.
 * Everything is optional; unconvertible parts are omitted (never thrown).
 */
export function routeSchema(options: RouteSchemaOptions): FastifySchema {
  const schema: Record<string, unknown> = {};

  if (options.tags) schema.tags = options.tags;
  if (options.summary) schema.summary = options.summary;
  if (options.description) schema.description = options.description;
  if (options.deprecated) schema.deprecated = true;

  // Request schemas use INPUT semantics: the runtime parses these with Zod, so
  // `.default()` fields are optional and unknown keys are stripped (not
  // rejected). See zodToOpenApi / module header note 2.
  if (options.body) {
    const body = zodToOpenApi(options.body, 'input');
    if (body) schema.body = body;
  }

  if (options.params) {
    const params = zodToOpenApi(options.params, 'input');
    if (params) schema.params = params;
  }

  if (options.querystring) {
    const querystring = zodToOpenApi(options.querystring, 'input');
    if (querystring) schema.querystring = querystring;
  }

  // Assemble the `response` map: declared success responses + error envelopes.
  const responses: Record<number, unknown> = {};

  if (options.response) {
    for (const [code, value] of Object.entries(options.response)) {
      const numericCode = Number(code);
      if (value instanceof z.ZodType) {
        // Response schemas use OUTPUT semantics (what the server serializes).
        const converted = zodToOpenApi(value, 'output');
        if (converted) responses[numericCode] = converted;
      } else {
        responses[numericCode] = value;
      }
    }
  }

  if (options.errors) {
    for (const code of options.errors) {
      // Don't clobber an explicit success/response entry for the same code.
      if (responses[code] === undefined) {
        responses[code] = errorEnvelopeResponse(code);
      }
    }
  }

  if (Object.keys(responses).length > 0) {
    schema.response = responses;
  }

  return schema as FastifySchema;
}
