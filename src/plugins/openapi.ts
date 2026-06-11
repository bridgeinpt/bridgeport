/**
 * OpenAPI 3 spec + Swagger UI for the BRIDGEPORT API.
 *
 * - JSON spec served at `GET /openapi.json` (no auth required).
 * - Interactive UI served at `/api/docs` (no auth required).
 *
 * Routes that don't declare schemas via Fastify's `schema` option still
 * appear in the spec with minimal info (path, method, tag) thanks to
 * @fastify/swagger's dynamic mode. Per-route request/response schemas
 * can be added incrementally without breaking the spec.
 *
 * IMPORTANT: this plugin must be registered BEFORE routes so it can
 * observe their schemas.
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ERROR_CODES } from '../lib/errors.js';

/**
 * The canonical error envelope, registered as a SHARED Fastify schema (`$id`)
 * rather than only as an OpenAPI component. This lets route `schema.response`
 * entries `$ref: 'ErrorEnvelope#'` resolve in BOTH @fastify/swagger (spec) and
 * fast-json-stringify (the response serializer) — a plain component-only schema
 * would break the serializer with `Cannot find reference ...`. See
 * `src/lib/openapi-schema.ts`.
 *
 * Exported so `routeSchema()` can reference the same `$id` consistently.
 */
export const ERROR_ENVELOPE_SCHEMA_ID = 'ErrorEnvelope';

export const errorEnvelopeSchema = {
  $id: ERROR_ENVELOPE_SCHEMA_ID,
  type: 'object',
  // NOTE: intentionally NO `required` and `additionalProperties: true`.
  // This schema does double duty: it documents the envelope in the spec AND is
  // the response serializer (fast-json-stringify) for routes that declare error
  // responses. Several routes still emit the LEGACY `{error}` body and rely on
  // the error-handler `onSend` hook to reshape it into `{code, message}` — but
  // serialization runs BEFORE that hook. A strict `required: ['code','message']`
  // would make fast-json-stringify THROW (`"code" is required`) on those legacy
  // bodies, turning a 4xx into a 500. Staying permissive lets the legacy body
  // pass through untouched so `onSend` can canonicalize it. The envelope ALWAYS
  // carries `code` + `message` on the wire (guaranteed by the error handler) —
  // see docs/api-stability.md for the authoritative contract.
  additionalProperties: true,
  properties: {
    code: {
      type: 'string',
      enum: [...ERROR_CODES],
      description: 'Stable, machine-readable error code. Always present on the wire.',
    },
    message: {
      type: 'string',
      description: 'Human-readable error message. Always present on the wire.',
    },
    field: {
      type: 'string',
      description: 'Field name when the error is tied to a specific input (e.g. validation).',
    },
    hint: {
      type: 'string',
      description: 'Optional, human-friendly hint for resolving the error.',
    },
    requestId: {
      type: 'string',
      description: 'Server-assigned request ID; quote this when reporting issues.',
    },
  },
  example: {
    code: 'READONLY_FIELD',
    message: 'Field "exposedPorts" is read-only and cannot be set via PATCH.',
    field: 'exposedPorts',
    hint: 'Exposed ports are discovered from the running container. Change the ports mapping in the compose file at composePath and redeploy.',
    requestId: 'req_01H0…',
  },
} as const;

async function openapiPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    // Map shared schemas ($id) to `#/components/schemas/<$id>` so route
    // `$ref`s render as clean component references in the spec.
    refResolver: {
      buildLocalReference: (json) => String(json.$id),
    },
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'BRIDGEPORT API',
        description:
          'HTTP API for BRIDGEPORT — a self-hosted deployment management tool for Docker-based infrastructure. ' +
          'All error responses follow the standard envelope: `{code, message, field?, hint?, requestId?}`.',
        // The spec version is intentionally pinned to a stable literal so the
        // checked-in `openapi.json` snapshot is byte-identical across builds.
        // The build/git stamp lives in `/health.version`, not the contract —
        // see docs/api-stability.md. The runtime build version is still
        // available via `APP_VERSION`; we just don't leak it into the spec.
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'BRIDGEPORT supports two bearer token types: short-lived JWTs (`Authorization: Bearer <jwt>`) ' +
              'issued by `POST /api/auth/login`, and long-lived API tokens (prefix `bport_pat_`) minted via ' +
              '`POST /api/admin/tokens`.',
          },
        },
        schemas: {
          // Standard envelope returned by every sync endpoint
          // (`POST /api/config-files/:id/sync-all`,
          //  `POST /api/services/:id/sync-files`,
          //  `POST /api/servers/:serverId/sync-all-files`). The `status` field
          // is the terminal outcome — clients should prefer it over the
          // deprecated top-level `success`. See issue #127.
          SyncResult: {
            type: 'object',
            required: ['status', 'targetsAttempted', 'targetsSucceeded', 'targetsFailed', 'results'],
            properties: {
              status: {
                type: 'string',
                enum: ['ok', 'no_targets', 'partial', 'failed'],
                description:
                  'Terminal outcome. `no_targets` is distinct from `ok` and signals "nothing to sync" — surface as a warning, not a green success.',
              },
              targetsAttempted: { type: 'integer', minimum: 0 },
              targetsSucceeded: { type: 'integer', minimum: 0 },
              targetsFailed: { type: 'integer', minimum: 0 },
              results: {
                type: 'array',
                description: 'Per-target results. Shape varies by endpoint (file/serviceName/targetPath/serverName/error).',
                items: { type: 'object', additionalProperties: true },
              },
              success: {
                type: 'boolean',
                deprecated: true,
                description: 'Deprecated alias for `status === "ok"`. Will be removed in a future release.',
              },
            },
          },
        },
        responses: {
          ErrorResponse: {
            description: 'Error envelope returned for any non-2xx response.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorEnvelope' },
              },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'auth', description: 'Authentication and current-user introspection' },
        { name: 'environments', description: 'Environments and per-environment resources' },
        { name: 'servers', description: 'Server management and health' },
        { name: 'services', description: 'Service templates, deployments, and runtime ops' },
        { name: 'secrets', description: 'Encrypted secret management' },
        { name: 'admin', description: 'Admin-only configuration (SMTP, webhooks, tokens, etc.)' },
        { name: 'monitoring', description: 'Health logs, metrics, and observability' },
      ],
    },
  });

  // Register the ErrorEnvelope as a shared schema so route response `$ref`s
  // resolve in both the spec and the response serializer. @fastify/swagger
  // auto-collects shared schemas into `#/components/schemas/ErrorEnvelope`.
  fastify.addSchema(errorEnvelopeSchema);

  await fastify.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  // Surface the raw JSON spec at /openapi.json (in addition to the
  // @fastify/swagger-ui default of /api/docs/json).
  fastify.get(
    '/openapi.json',
    {
      // Don't recurse — the spec describes itself but we don't need to
      // advertise this introspection endpoint in the spec.
      schema: { hide: true } as unknown as Record<string, unknown>,
    },
    async () => {
      return fastify.swagger();
    }
  );
}

export default fp(openapiPlugin, {
  name: 'openapi',
});
