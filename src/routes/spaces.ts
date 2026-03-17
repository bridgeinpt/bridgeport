import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import { safeJsonParse } from '../lib/helpers.js';
import { S3Client, ListBucketsCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

const spacesConfigSchema = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().optional(), // Optional for updates - will keep existing if not provided
  region: z.string().min(1).default('fra1'),
  endpoint: z.string().optional(),
  buckets: z.array(z.string()).optional(), // Manual bucket list for scoped keys
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

      // Parse buckets from JSON
      const buckets: string[] = safeJsonParse(config.buckets, [] as string[]);

      return {
        configured: true,
        config: {
          id: config.id,
          accessKey: config.accessKey,
          region: config.region,
          endpoint: config.endpoint,
          buckets,
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
      const body = spacesConfigSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Check if config already exists
      const existing = await prisma.spacesConfig.findFirst();

      // For new configs, secretKey is required
      if (!existing && !body.data.secretKey) {
        return reply.code(400).send({ error: 'Secret key is required for new configuration' });
      }

      const endpoint = body.data.endpoint || `${body.data.region}.digitaloceanspaces.com`;
      const bucketsJson = body.data.buckets ? JSON.stringify(body.data.buckets) : null;

      let config;
      if (existing) {
        // For updates, only encrypt new secret if provided
        const updateData: Record<string, unknown> = {
          accessKey: body.data.accessKey,
          region: body.data.region,
          endpoint,
          buckets: bucketsJson,
        };

        if (body.data.secretKey) {
          const { ciphertext, nonce } = encrypt(body.data.secretKey);
          updateData.encryptedSecretKey = ciphertext;
          updateData.secretKeyNonce = nonce;
        }

        config = await prisma.spacesConfig.update({
          where: { id: existing.id },
          data: updateData,
        });

        await logAudit({
          action: 'update',
          resourceType: 'spaces_config',
          resourceId: config.id,
          details: { region: body.data.region },
          userId: request.authUser!.id,
        });
      } else {
        // For new config, secretKey is guaranteed to be present (validated above)
        const { ciphertext, nonce } = encrypt(body.data.secretKey!);
        config = await prisma.spacesConfig.create({
          data: {
            accessKey: body.data.accessKey,
            encryptedSecretKey: ciphertext,
            secretKeyNonce: nonce,
            region: body.data.region,
            endpoint,
            buckets: bucketsJson,
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

        // Parse configured buckets
        const configuredBuckets: string[] = safeJsonParse(config.buckets, [] as string[]);

        // If buckets are manually configured, test access to the first one
        if (configuredBuckets.length > 0) {
          // Test access to each configured bucket
          const accessibleBuckets: string[] = [];
          const failedBuckets: string[] = [];

          for (const bucket of configuredBuckets) {
            try {
              await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
              accessibleBuckets.push(bucket);
            } catch {
              failedBuckets.push(bucket);
            }
          }

          if (accessibleBuckets.length === 0) {
            return reply.code(400).send({
              success: false,
              error: `Cannot access any configured buckets: ${failedBuckets.join(', ')}`,
            });
          }

          return {
            success: true,
            message: failedBuckets.length > 0
              ? `Connected. Access to ${accessibleBuckets.length}/${configuredBuckets.length} buckets.`
              : 'Connection successful',
            buckets: accessibleBuckets,
            failedBuckets: failedBuckets.length > 0 ? failedBuckets : undefined,
            scopedKey: true,
          };
        }

        // No buckets configured - try to list buckets (requires full API access)
        try {
          const result = await s3Client.send(new ListBucketsCommand({}));
          const buckets = result.Buckets?.map((b) => b.Name).filter((name): name is string => !!name) || [];

          return {
            success: true,
            message: 'Connection successful (full API access)',
            buckets,
            scopedKey: false,
          };
        } catch (listError) {
          // ListBuckets failed - likely a scoped key
          const errMsg = listError instanceof Error ? listError.message : '';
          if (errMsg.includes('AccessDenied') || errMsg.includes('403')) {
            return reply.code(400).send({
              success: false,
              error: 'This appears to be a bucket-scoped key. Please add the bucket names manually.',
              scopedKey: true,
            });
          }
          throw listError;
        }
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

      // Parse configured buckets
      const configuredBuckets: string[] = safeJsonParse(config.buckets, [] as string[]);

      // If buckets are manually configured, return those
      if (configuredBuckets.length > 0) {
        return { buckets: configuredBuckets, source: 'configured' };
      }

      // Try to discover buckets via API (requires full access)
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

        return { buckets, source: 'discovered' };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : '';
        if (errMsg.includes('AccessDenied') || errMsg.includes('403')) {
          return reply.code(400).send({
            error: 'Cannot list buckets with this key. Add bucket names manually in Spaces settings.',
            scopedKey: true,
          });
        }
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
