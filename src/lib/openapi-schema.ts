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
 * 2. NEVER CRASH REGISTRATION. Some Zod schemas use `.transform()` (which
 *    `z.toJSONSchema()` cannot represent and THROWS on) or `.refine()` (silently
 *    dropped). Every conversion is wrapped in try/catch: on failure we omit that
 *    fragment rather than break route registration. Docs are best-effort.
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

/**
 * Convert a Zod schema to OpenAPI 3.0 JSON Schema. Returns `undefined` on any
 * failure (e.g. `.transform()` which cannot be represented) so callers can omit
 * the fragment without crashing route registration.
 *
 * We target `openapi-3.0` to match the plugin's `openapi: '3.0.3'` (avoids
 * draft-2020-12 keywords like `prefixItems` that an OpenAPI 3.0 validator would
 * reject).
 */
export function zodToOpenApi(schema: ZodType): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as Record<string, unknown>;
  } catch {
    // Best-effort: a non-representable schema (transform, etc.) is simply
    // omitted from the spec. Validation is unaffected (still done by Zod).
    return undefined;
  }
}

/**
 * Mark a single property of an already-converted JSON Schema object as
 * `deprecated: true`. No-op if the property is absent. Used for the sync
 * envelope's `success` alias (issue #127). Returns the same object for chaining.
 */
export function markPropertyDeprecated(
  jsonSchema: Record<string, unknown>,
  property: string
): Record<string, unknown> {
  const props = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props && props[property]) {
    props[property].deprecated = true;
  }
  return jsonSchema;
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

  if (options.body) {
    const body = zodToOpenApi(options.body);
    if (body) schema.body = body;
  }

  if (options.params) {
    const params = zodToOpenApi(options.params);
    if (params) schema.params = params;
  }

  if (options.querystring) {
    const querystring = zodToOpenApi(options.querystring);
    if (querystring) schema.querystring = querystring;
  }

  // Assemble the `response` map: declared success responses + error envelopes.
  const responses: Record<number, unknown> = {};

  if (options.response) {
    for (const [code, value] of Object.entries(options.response)) {
      const numericCode = Number(code);
      if (value instanceof z.ZodType) {
        const converted = zodToOpenApi(value);
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
