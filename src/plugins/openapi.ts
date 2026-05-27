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
import { appVersion } from '../lib/version.js';
import { ERROR_CODES } from '../lib/errors.js';

async function openapiPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'BRIDGEPORT API',
        description:
          'HTTP API for BRIDGEPORT — a self-hosted deployment management tool for Docker-based infrastructure. ' +
          'All error responses follow the standard envelope: `{code, message, field?, hint?, requestId?}`.',
        version: process.env.APP_VERSION || appVersion || '1.0.0',
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
          ErrorEnvelope: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [...ERROR_CODES],
                description: 'Stable, machine-readable error code.',
              },
              message: {
                type: 'string',
                description: 'Human-readable error message.',
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
