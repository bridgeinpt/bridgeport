import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { createApiToken, listApiTokens, deleteApiToken } from '../services/auth.js';
import { send, NOTIFICATION_TYPES } from '../services/notifications.js';
import { validateBody, findOrNotFound, getErrorMessage } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

// Hard cap: a token cannot live longer than this. Forces credential rotation.
const MAX_TOKEN_LIFETIME_DAYS = 365;

const tokenIdParams = z.object({ tokenId: z.string() });

const createTokenSchema = z
  .object({
    name: z.string().min(1).max(100),
    ownerUserId: z.string().optional(),
    ownerServiceAccountId: z.string().optional(),
    role: z.enum(['admin', 'operator', 'viewer']),
    allEnvironments: z.boolean(),
    environmentIds: z.array(z.string()).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_TOKEN_LIFETIME_DAYS),
  })
  .refine((d) => !!d.ownerUserId !== !!d.ownerServiceAccountId, {
    message: 'Specify exactly one of ownerUserId or ownerServiceAccountId',
    path: ['ownerUserId'],
  })
  .refine((d) => d.allEnvironments || (d.environmentIds && d.environmentIds.length > 0), {
    message: 'When allEnvironments is false, provide at least one environmentId',
    path: ['environmentIds'],
  });

export async function apiTokenRoutes(fastify: FastifyInstance): Promise<void> {
  // List tokens (admin only; optional filter by owner)
  fastify.get(
    '/api/admin/tokens',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'List API tokens (optionally filtered by owner)',
        errors: [401, 403],
      }),
    },
    async (request) => {
      const query = request.query as { ownerUserId?: string; ownerServiceAccountId?: string };
      const tokens = await listApiTokens({
        userId: query.ownerUserId,
        serviceAccountId: query.ownerServiceAccountId,
      });
      return { tokens };
    }
  );

  // Create token (admin only)
  fastify.post(
    '/api/admin/tokens',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Create an API token (full token returned once)',
        body: createTokenSchema,
        errors: [400, 401, 403],
      }),
    },
    async (request, reply) => {
      const body = validateBody(createTokenSchema, request, reply);
      if (!body) return;

      const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

      try {
        const { token, tokenRecord } = await createApiToken({
          name: body.name,
          ownerUserId: body.ownerUserId,
          ownerServiceAccountId: body.ownerServiceAccountId,
          role: body.role,
          allEnvironments: body.allEnvironments,
          environmentIds: body.environmentIds,
          expiresAt,
        });

        await logAudit({
          action: 'create',
          resourceType: 'api_token',
          resourceId: tokenRecord.id,
          resourceName: tokenRecord.name,
          details: {
            role: tokenRecord.role,
            allEnvironments: tokenRecord.allEnvironments,
            environmentIds: body.environmentIds,
            ownerUserId: body.ownerUserId,
            ownerServiceAccountId: body.ownerServiceAccountId,
          },
          ...actorFrom(request),
        });

        // Notify the human owner (skip for service-account-owned tokens).
        if (body.ownerUserId) {
          await send(NOTIFICATION_TYPES.USER_API_TOKEN_CREATED, body.ownerUserId, {
            tokenName: body.name,
          });
        }

        return {
          // Full token returned ONCE — never retrievable again.
          token,
          tokenRecord: {
            id: tokenRecord.id,
            name: tokenRecord.name,
            tokenPrefix: tokenRecord.tokenPrefix,
            role: tokenRecord.role,
            allEnvironments: tokenRecord.allEnvironments,
            expiresAt: tokenRecord.expiresAt,
            createdAt: tokenRecord.createdAt,
            userId: tokenRecord.userId,
            serviceAccountId: tokenRecord.serviceAccountId,
          },
        };
      } catch (err) {
        return reply.code(400).send({ error: getErrorMessage(err, 'Failed to create token') });
      }
    }
  );

  // Revoke token (admin only)
  fastify.delete(
    '/api/admin/tokens/:tokenId',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Revoke an API token',
        params: tokenIdParams,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { tokenId } = request.params as { tokenId: string };

      const existing = await findOrNotFound(
        prisma.apiToken.findUnique({
          where: { id: tokenId },
          select: { id: true, name: true, userId: true, serviceAccountId: true },
        }),
        'Token',
        reply
      );
      if (!existing) return;

      await deleteApiToken(tokenId);

      await logAudit({
        action: 'delete',
        resourceType: 'api_token',
        resourceId: tokenId,
        resourceName: existing.name,
        details: {
          ownerUserId: existing.userId,
          ownerServiceAccountId: existing.serviceAccountId,
        },
        ...actorFrom(request),
      });

      return { success: true };
    }
  );
}
