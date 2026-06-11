import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { validateBody, findOrNotFound } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const serviceAccountIdParams = z.object({ id: z.string() });

const createServiceAccountSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(NAME_PATTERN, 'Use lowercase letters, digits, hyphens, or underscores'),
  description: z.string().max(500).optional(),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
});

const updateServiceAccountSchema = z.object({
  description: z.string().max(500).optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  disabled: z.boolean().optional(),
});

export async function serviceAccountRoutes(fastify: FastifyInstance): Promise<void> {
  // List service accounts (admin only)
  fastify.get(
    '/api/admin/service-accounts',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'List service accounts',
        errors: [401, 403],
      }),
    },
    async () => {
      const accounts = await prisma.serviceAccount.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { id: true, email: true, name: true } },
          _count: { select: { apiTokens: true } },
        },
      });
      return { serviceAccounts: accounts };
    }
  );

  // Get one (admin only)
  fastify.get(
    '/api/admin/service-accounts/:id',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Get a service account',
        params: serviceAccountIdParams,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const account = await findOrNotFound(
        prisma.serviceAccount.findUnique({
          where: { id },
          include: {
            createdBy: { select: { id: true, email: true, name: true } },
            _count: { select: { apiTokens: true } },
          },
        }),
        'Service account',
        reply
      );
      if (!account) return;
      return { serviceAccount: account };
    }
  );

  // Create (admin only)
  fastify.post(
    '/api/admin/service-accounts',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Create a service account',
        body: createServiceAccountSchema,
        errors: [400, 401, 403, 409],
      }),
    },
    async (request, reply) => {
      const body = validateBody(createServiceAccountSchema, request, reply);
      if (!body) return;

      const existing = await prisma.serviceAccount.findUnique({
        where: { name: body.name },
      });
      if (existing) {
        return reply.code(409).send({ error: 'Name already in use' });
      }

      const account = await prisma.serviceAccount.create({
        data: {
          name: body.name,
          description: body.description,
          role: body.role,
          createdByUserId: userIdForFk(request.authUser!),
        },
        include: {
          createdBy: { select: { id: true, email: true, name: true } },
          _count: { select: { apiTokens: true } },
        },
      });

      await logAudit({
        action: 'create',
        resourceType: 'service_account',
        resourceId: account.id,
        resourceName: account.name,
        details: { role: account.role },
        ...actorFrom(request),
      });

      return { serviceAccount: account };
    }
  );

  // Update (admin only)
  fastify.patch(
    '/api/admin/service-accounts/:id',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Update a service account',
        params: serviceAccountIdParams,
        body: updateServiceAccountSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateServiceAccountSchema, request, reply);
      if (!body) return;

      const existing = await findOrNotFound(
        prisma.serviceAccount.findUnique({ where: { id } }),
        'Service account',
        reply
      );
      if (!existing) return;

      const account = await prisma.serviceAccount.update({
        where: { id },
        data: {
          description: body.description,
          role: body.role,
          disabled: body.disabled,
        },
        include: {
          createdBy: { select: { id: true, email: true, name: true } },
          _count: { select: { apiTokens: true } },
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'service_account',
        resourceId: account.id,
        resourceName: account.name,
        details: body as Record<string, unknown>,
        ...actorFrom(request),
      });

      return { serviceAccount: account };
    }
  );

  // Delete (admin only) — cascades to its tokens via FK ON DELETE CASCADE
  fastify.delete(
    '/api/admin/service-accounts/:id',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Delete a service account (cascades to its tokens)',
        params: serviceAccountIdParams,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await findOrNotFound(
        prisma.serviceAccount.findUnique({
          where: { id },
          include: { _count: { select: { apiTokens: true } } },
        }),
        'Service account',
        reply
      );
      if (!existing) return;

      await prisma.serviceAccount.delete({ where: { id } });

      await logAudit({
        action: 'delete',
        resourceType: 'service_account',
        resourceId: id,
        resourceName: existing.name,
        details: { revokedTokens: existing._count.apiTokens },
        ...actorFrom(request),
      });

      return { success: true };
    }
  );
}
