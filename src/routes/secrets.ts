import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  createSecret,
  updateSecret,
  getSecretValue,
  listSecrets,
  deleteSecret,
} from '../services/secrets.js';
import { logAudit } from '../services/audit.js';

const createSecretSchema = z.object({
  key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase with underscores'),
  value: z.string().min(1),
  description: z.string().optional(),
  neverReveal: z.boolean().optional().default(false),
});

const updateSecretSchema = z.object({
  value: z.string().min(1).optional(),
  description: z.string().optional(),
  neverReveal: z.boolean().optional(),
});

export async function secretRoutes(fastify: FastifyInstance): Promise<void> {
  // List secrets (without values)
  fastify.get(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const secrets = await listSecrets(envId);
      return { secrets };
    }
  );

  // Create secret
  fastify.post(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createSecretSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const secret = await createSecret(envId, body.data);

        await logAudit({
          action: 'create',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { secret };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Secret already exists' });
        }
        throw error;
      }
    }
  );

  // Get secret value (requires explicit action)
  fastify.get(
    '/api/secrets/:id/value',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await prisma.secret.findUnique({
          where: { id },
          include: { environment: true },
        });

        if (!secret) {
          return reply.code(404).send({ error: 'Secret not found' });
        }

        // Check environment-level reveal setting
        if (!secret.environment.allowSecretReveal) {
          await logAudit({
            action: 'access',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            details: { blocked: true, reason: 'environment_disabled' },
            success: false,
            error: 'Secret reveal disabled for this environment',
            userId: request.authUser!.id,
            environmentId: secret.environmentId,
          });
          return reply.code(403).send({ error: 'Secret reveal is disabled for this environment' });
        }

        // Check secret-level reveal setting
        if (secret.neverReveal) {
          await logAudit({
            action: 'access',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            details: { blocked: true, reason: 'write_only' },
            success: false,
            error: 'This secret is write-only',
            userId: request.authUser!.id,
            environmentId: secret.environmentId,
          });
          return reply.code(403).send({ error: 'This secret is write-only and cannot be revealed' });
        }

        const value = await getSecretValue(id);

        await logAudit({
          action: 'access',
          resourceType: 'secret',
          resourceId: id,
          resourceName: secret.key,
          userId: request.authUser!.id,
          environmentId: secret.environmentId,
        });

        return { value };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Update secret
  fastify.patch(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateSecretSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.secret.findUnique({ where: { id } });
        const secret = await updateSecret(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          details: { valueChanged: !!body.data.value, descriptionChanged: !!body.data.description },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { secret };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Delete secret
  fastify.delete(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await prisma.secret.findUnique({ where: { id } });
        await deleteSecret(id);

        if (secret) {
          await logAudit({
            action: 'delete',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            userId: request.authUser!.id,
            environmentId: secret.environmentId,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );
}
