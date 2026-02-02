import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logAudit } from '../services/audit.js';
import { requireAdmin } from '../plugins/authorize.js';

const createEnvSchema = z.object({
  name: z.string().min(1).max(50),
});

const updateSshSchema = z.object({
  sshPrivateKey: z.string().min(1),
  sshUser: z.string().min(1).default('root'),
});

const updateSettingsSchema = z.object({
  allowSecretReveal: z.boolean().optional(),
});

export async function environmentRoutes(fastify: FastifyInstance): Promise<void> {
  // List environments
  fastify.get(
    '/api/environments',
    { preHandler: [fastify.authenticate] },
    async () => {
      const environments = await prisma.environment.findMany({
        include: {
          _count: {
            select: { servers: true, secrets: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      return { environments };
    }
  );

  // Get environment
  fastify.get(
    '/api/environments/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const environment = await prisma.environment.findUnique({
        where: { id },
        include: {
          servers: {
            include: {
              services: true,
            },
          },
          _count: {
            select: { secrets: true },
          },
        },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      return { environment };
    }
  );

  // Create environment (admin only)
  fastify.post(
    '/api/environments',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createEnvSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.environment.findUnique({
        where: { name: body.data.name },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Environment already exists' });
      }

      const environment = await prisma.environment.create({
        data: { name: body.data.name },
      });

      await logAudit({
        action: 'create',
        resourceType: 'environment',
        resourceId: environment.id,
        resourceName: environment.name,
        userId: request.authUser!.id,
        environmentId: environment.id,
      });

      return { environment };
    }
  );

  // Delete environment (admin only)
  fastify.delete(
    '/api/environments/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const environment = await prisma.environment.findUnique({ where: { id } });
        await prisma.environment.delete({
          where: { id },
        });

        if (environment) {
          await logAudit({
            action: 'delete',
            resourceType: 'environment',
            resourceId: id,
            resourceName: environment.name,
            userId: request.authUser!.id,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Environment not found' });
      }
    }
  );

  // Update SSH settings for environment (admin only)
  fastify.put(
    '/api/environments/:id/ssh',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateSshSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const environment = await prisma.environment.findUnique({
        where: { id },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Encrypt the private key before storing
      const { ciphertext, nonce } = encrypt(body.data.sshPrivateKey);
      const encryptedKey = `${nonce}:${ciphertext}`;

      await prisma.environment.update({
        where: { id },
        data: {
          sshPrivateKey: encryptedKey,
          sshUser: body.data.sshUser,
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: environment.name,
        details: { sshUser: body.data.sshUser, sshKeyUpdated: true },
        userId: request.authUser!.id,
        environmentId: id,
      });

      return { success: true, message: 'SSH settings updated' };
    }
  );

  // Check if SSH key is configured for environment
  fastify.get(
    '/api/environments/:id/ssh',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const environment = await prisma.environment.findUnique({
        where: { id },
        select: { id: true, name: true, sshUser: true, sshPrivateKey: true },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      return {
        configured: !!environment.sshPrivateKey,
        sshUser: environment.sshUser,
      };
    }
  );

  // Get environment settings
  fastify.get(
    '/api/environments/:id/settings',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const environment = await prisma.environment.findUnique({
        where: { id },
        select: { id: true, name: true, allowSecretReveal: true },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      return { settings: { allowSecretReveal: environment.allowSecretReveal } };
    }
  );

  // Update environment settings (admin only)
  fastify.patch(
    '/api/environments/:id/settings',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateSettingsSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const environment = await prisma.environment.findUnique({
        where: { id },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const updateData: { allowSecretReveal?: boolean } = {};
      if (body.data.allowSecretReveal !== undefined) {
        updateData.allowSecretReveal = body.data.allowSecretReveal;
      }

      const updated = await prisma.environment.update({
        where: { id },
        data: updateData,
        select: { id: true, name: true, allowSecretReveal: true },
      });

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: environment.name,
        details: { settingsUpdated: updateData },
        userId: request.authUser!.id,
        environmentId: id,
      });

      return { settings: { allowSecretReveal: updated.allowSecretReveal } };
    }
  );
}

// Helper to get decrypted SSH key for an environment
export async function getEnvironmentSshKey(environmentId: string): Promise<{
  privateKey: string;
  username: string;
} | null> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { sshPrivateKey: true, sshUser: true },
  });

  if (!environment?.sshPrivateKey) {
    return null;
  }

  const [nonce, ciphertext] = environment.sshPrivateKey.split(':');
  const privateKey = decrypt(ciphertext, nonce);

  return {
    privateKey,
    username: environment.sshUser,
  };
}
