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
import { validateBody, findOrNotFound, handleUniqueConstraint } from '../lib/helpers.js';

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
  // List secrets (without values) with usage information
  fastify.get(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const secrets = await listSecrets(envId);

      // Get all config files for this environment to check for secret usage
      const configFiles = await prisma.configFile.findMany({
        where: { environmentId: envId },
        select: {
          id: true,
          name: true,
          filename: true,
          content: true,
          services: {
            select: {
              service: {
                select: {
                  id: true,
                  name: true,
                  server: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Build usage map for each secret
      const secretsWithUsage = secrets.map((secret) => {
        // Look for patterns like ${SECRET_KEY}, $SECRET_KEY, or {{SECRET_KEY}}
        const keyPatterns = [
          `\${${secret.key}}`,
          `$${secret.key}`,
          `{{${secret.key}}}`,
          // Also look for the key in .env file format: KEY=
          new RegExp(`^${secret.key}=`, 'm'),
        ];

        const usedByConfigFiles: Array<{
          id: string;
          name: string;
          filename: string;
          services: Array<{ id: string; name: string; serverName: string }>;
        }> = [];

        for (const file of configFiles) {
          const contentMatches = keyPatterns.some((pattern) => {
            if (pattern instanceof RegExp) {
              return pattern.test(file.content);
            }
            return file.content.includes(pattern);
          });

          if (contentMatches) {
            usedByConfigFiles.push({
              id: file.id,
              name: file.name,
              filename: file.filename,
              services: file.services.map((sf) => ({
                id: sf.service.id,
                name: sf.service.name,
                serverName: sf.service.server.name,
              })),
            });
          }
        }

        // Derive unique services that use this secret
        const usedByServices = new Map<string, { id: string; name: string; serverName: string }>();
        for (const file of usedByConfigFiles) {
          for (const service of file.services) {
            if (!usedByServices.has(service.id)) {
              usedByServices.set(service.id, service);
            }
          }
        }

        return {
          ...secret,
          usedByConfigFiles,
          usedByServices: Array.from(usedByServices.values()),
          usageCount: usedByServices.size,
        };
      });

      return { secrets: secretsWithUsage };
    }
  );

  // Create secret
  fastify.post(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createSecretSchema, request, reply);
      if (!body) return;

      try {
        const secret = await createSecret(envId, body);

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
        if (handleUniqueConstraint(error, 'Secret already exists', reply)) return;
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
        const secret = await findOrNotFound(prisma.secret.findUnique({ where: { id } }), 'Secret', reply);
        if (!secret) return;

        // Check environment-level reveal setting
        const configSettings = await prisma.configurationSettings.findUnique({
          where: { environmentId: secret.environmentId },
        });
        if (configSettings && !configSettings.allowSecretReveal) {
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
      const body = validateBody(updateSecretSchema, request, reply);
      if (!body) return;

      try {
        const existing = await prisma.secret.findUnique({ where: { id } });
        const secret = await updateSecret(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          details: { valueChanged: !!body.value, descriptionChanged: !!body.description },
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
