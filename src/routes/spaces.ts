import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

const createSpacesConfigSchema = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  region: z.string().min(1).default('fra1'),
  endpoint: z.string().optional(),
});

const updateSpacesConfigSchema = z.object({
  accessKey: z.string().min(1).optional(),
  secretKey: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  endpoint: z.string().optional(),
});

const updateEnvironmentSpacesSchema = z.object({
  enabled: z.boolean(),
});

export async function spacesRoutes(fastify: FastifyInstance): Promise<void> {
  // Get global Spaces configuration
  fastify.get(
    '/api/settings/spaces',
    { preHandler: [fastify.authenticate] },
    async () => {
      const config = await prisma.spacesConfig.findFirst({
        include: {
          enabledEnvironments: true,
        },
      });

      if (!config) {
        return { configured: false, config: null };
      }

      return {
        configured: true,
        config: {
          id: config.id,
          accessKey: config.accessKey,
          region: config.region,
          endpoint: config.endpoint,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
          enabledEnvironments: config.enabledEnvironments,
        },
      };
    }
  );

  // Create or update global Spaces configuration (admin only)
  fastify.put(
    '/api/settings/spaces',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createSpacesConfigSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Encrypt the secret key
      const { ciphertext, nonce } = encrypt(body.data.secretKey);
      const endpoint = body.data.endpoint || `${body.data.region}.digitaloceanspaces.com`;

      // Check if config already exists
      const existing = await prisma.spacesConfig.findFirst();

      let config;
      if (existing) {
        config = await prisma.spacesConfig.update({
          where: { id: existing.id },
          data: {
            accessKey: body.data.accessKey,
            encryptedSecretKey: ciphertext,
            secretKeyNonce: nonce,
            region: body.data.region,
            endpoint,
          },
        });

        await logAudit({
          action: 'update',
          resourceType: 'spaces_config',
          resourceId: config.id,
          details: { region: body.data.region },
          userId: request.authUser!.id,
        });
      } else {
        config = await prisma.spacesConfig.create({
          data: {
            accessKey: body.data.accessKey,
            encryptedSecretKey: ciphertext,
            secretKeyNonce: nonce,
            region: body.data.region,
            endpoint,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'spaces_config',
          resourceId: config.id,
          details: { region: body.data.region },
          userId: request.authUser!.id,
        });
      }

      return {
        config: {
          id: config.id,
          accessKey: config.accessKey,
          region: config.region,
          endpoint: config.endpoint,
        },
      };
    }
  );

  // Delete global Spaces configuration (admin only)
  fastify.delete(
    '/api/settings/spaces',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const existing = await prisma.spacesConfig.findFirst();
      if (!existing) {
        return reply.code(404).send({ error: 'Spaces configuration not found' });
      }

      await prisma.spacesConfig.delete({ where: { id: existing.id } });

      await logAudit({
        action: 'delete',
        resourceType: 'spaces_config',
        resourceId: existing.id,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Test Spaces connection
  fastify.post(
    '/api/settings/spaces/test',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const config = await prisma.spacesConfig.findFirst();
      if (!config) {
        return reply.code(400).send({ success: false, error: 'Spaces not configured' });
      }

      try {
        const secretKey = decrypt(config.encryptedSecretKey, config.secretKeyNonce);

        const s3Client = new S3Client({
          endpoint: `https://${config.endpoint}`,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: secretKey,
          },
        });

        const result = await s3Client.send(new ListBucketsCommand({}));
        const buckets = result.Buckets?.map((b) => b.Name).filter((name): name is string => !!name) || [];

        return {
          success: true,
          message: 'Connection successful',
          buckets,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection test failed';
        return reply.code(400).send({ success: false, error: message });
      }
    }
  );

  // List Spaces buckets
  fastify.get(
    '/api/settings/spaces/buckets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const config = await prisma.spacesConfig.findFirst();
      if (!config) {
        return reply.code(400).send({ error: 'Spaces not configured' });
      }

      try {
        const secretKey = decrypt(config.encryptedSecretKey, config.secretKeyNonce);

        const s3Client = new S3Client({
          endpoint: `https://${config.endpoint}`,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: secretKey,
          },
        });

        const result = await s3Client.send(new ListBucketsCommand({}));
        const buckets = result.Buckets?.map((b) => b.Name).filter((name): name is string => !!name) || [];

        return { buckets };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list buckets';
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Get environment-specific Spaces enablement
  fastify.get(
    '/api/settings/spaces/environments',
    { preHandler: [fastify.authenticate] },
    async () => {
      const config = await prisma.spacesConfig.findFirst({
        include: {
          enabledEnvironments: true,
        },
      });

      const environments = await prisma.environment.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });

      const enabledEnvIds = new Set(config?.enabledEnvironments.filter((e) => e.enabled).map((e) => e.environmentId) || []);

      return {
        environments: environments.map((env) => ({
          id: env.id,
          name: env.name,
          spacesEnabled: enabledEnvIds.has(env.id),
        })),
      };
    }
  );

  // Enable/disable Spaces for a specific environment (admin only)
  fastify.put(
    '/api/settings/spaces/environments/:environmentId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { environmentId } = request.params as { environmentId: string };
      const body = updateEnvironmentSpacesSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const config = await prisma.spacesConfig.findFirst();
      if (!config) {
        return reply.code(400).send({ error: 'Spaces not configured' });
      }

      const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Upsert the SpacesEnvironment record
      await prisma.spacesEnvironment.upsert({
        where: {
          spacesConfigId_environmentId: {
            spacesConfigId: config.id,
            environmentId,
          },
        },
        update: { enabled: body.data.enabled },
        create: {
          spacesConfigId: config.id,
          environmentId,
          enabled: body.data.enabled,
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'spaces_environment',
        resourceId: environmentId,
        resourceName: environment.name,
        details: { spacesEnabled: body.data.enabled },
        userId: request.authUser!.id,
        environmentId,
      });

      return { success: true, enabled: body.data.enabled };
    }
  );
}

// Helper to get Spaces credentials if enabled for an environment
export async function getSpacesConfigForEnvironment(environmentId: string): Promise<{
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
} | null> {
  const config = await prisma.spacesConfig.findFirst({
    include: {
      enabledEnvironments: {
        where: { environmentId, enabled: true },
      },
    },
  });

  if (!config || config.enabledEnvironments.length === 0) {
    return null;
  }

  const secretKey = decrypt(config.encryptedSecretKey, config.secretKeyNonce);

  return {
    accessKey: config.accessKey,
    secretKey,
    region: config.region,
    endpoint: config.endpoint,
  };
}
