import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logAudit } from '../services/audit.js';
import { requireAdmin } from '../plugins/authorize.js';
import { createDefaultSettings } from '../services/environment-settings.js';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

const createEnvSchema = z.object({
  name: z.string().min(1).max(50),
});

const updateSshSchema = z.object({
  sshPrivateKey: z.string().min(1),
  sshUser: z.string().min(1).default('root'),
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
              services: {
                include: {
                  serviceType: true,
                  containerImage: true,
                },
              },
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

      await createDefaultSettings(environment.id);

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
        },
      });

      await prisma.generalSettings.upsert({
        where: { environmentId: id },
        update: { sshUser: body.data.sshUser },
        create: { environmentId: id, sshUser: body.data.sshUser },
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
        select: { id: true, name: true, sshPrivateKey: true },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const generalSettings = await prisma.generalSettings.findUnique({
        where: { environmentId: id },
      });

      return {
        configured: !!environment.sshPrivateKey,
        sshUser: generalSettings?.sshUser ?? 'root',
      };
    }
  );

  // Delete SSH key for environment (admin only)
  fastify.delete(
    '/api/environments/:id/ssh',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const environment = await prisma.environment.findUnique({
        where: { id },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      await prisma.environment.update({
        where: { id },
        data: {
          sshPrivateKey: null,
        },
      });

      await prisma.generalSettings.upsert({
        where: { environmentId: id },
        update: { sshUser: 'root' },
        create: { environmentId: id, sshUser: 'root' },
      });

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: environment.name,
        details: { sshKeyDeleted: true },
        userId: request.authUser!.id,
        environmentId: id,
      });

      return { success: true, message: 'SSH key removed' };
    }
  );

  // Get SSH key for CLI access (admin only)
  // This endpoint returns the actual private key for CLI tools to use
  fastify.get(
    '/api/environments/:id/ssh-key',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const environment = await prisma.environment.findUnique({
        where: { id },
        select: { id: true, name: true },
      });

      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const sshCreds = await getEnvironmentSshKey(id);
      if (!sshCreds) {
        return reply.code(404).send({ error: 'SSH key not configured for this environment' });
      }

      // Audit log the access
      await logAudit({
        action: 'ssh_key_access',
        resourceType: 'environment',
        resourceId: id,
        resourceName: environment.name,
        details: { method: 'cli' },
        userId: request.authUser!.id,
        environmentId: id,
      });

      return {
        privateKey: sshCreds.privateKey,
        username: sshCreds.username,
      };
    }
  );

  // List Spaces buckets
  fastify.get(
    '/api/environments/:id/spaces/buckets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const spacesConfig = await getEnvironmentSpacesConfig(id);
      if (!spacesConfig) {
        return reply.code(400).send({
          error: 'Spaces is not configured for this environment'
        });
      }

      // If buckets are configured (scoped key), return those directly
      if (spacesConfig.buckets && spacesConfig.buckets.length > 0) {
        return { buckets: spacesConfig.buckets, source: 'configured' };
      }

      // Otherwise try to list via API (requires full access key)
      try {
        const s3Client = new S3Client({
          endpoint: `https://${spacesConfig.endpoint}`,
          region: spacesConfig.region,
          credentials: {
            accessKeyId: spacesConfig.accessKey,
            secretAccessKey: spacesConfig.secretKey,
          },
        });

        const result = await s3Client.send(new ListBucketsCommand({}));
        const buckets = result.Buckets?.map(b => b.Name).filter((name): name is string => !!name) || [];

        return { buckets, source: 'discovered' };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : '';
        if (errMsg.includes('AccessDenied') || errMsg.includes('403')) {
          return reply.code(400).send({
            error: 'Cannot list buckets with this key. Add bucket names in Global Spaces settings.',
            scopedKey: true,
          });
        }
        const message = error instanceof Error ? error.message : 'Failed to list buckets';
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Test Spaces configuration
  fastify.post(
    '/api/environments/:id/spaces/test',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const spacesConfig = await getEnvironmentSpacesConfig(id);
      if (!spacesConfig) {
        return reply.code(400).send({
          success: false,
          error: 'Spaces is not configured for this environment'
        });
      }

      const s3Client = new S3Client({
        endpoint: `https://${spacesConfig.endpoint}`,
        region: spacesConfig.region,
        credentials: {
          accessKeyId: spacesConfig.accessKey,
          secretAccessKey: spacesConfig.secretKey,
        },
      });

      // If buckets are configured, test access to them with HeadBucket
      if (spacesConfig.buckets && spacesConfig.buckets.length > 0) {
        const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
        const accessibleBuckets: string[] = [];
        const failedBuckets: string[] = [];

        for (const bucket of spacesConfig.buckets) {
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
            ? `Connected. Access to ${accessibleBuckets.length}/${spacesConfig.buckets.length} buckets.`
            : 'Connection successful',
          buckets: accessibleBuckets,
          failedBuckets: failedBuckets.length > 0 ? failedBuckets : undefined,
          scopedKey: true,
        };
      }

      // No buckets configured - try ListBuckets (requires full API access)
      try {
        const result = await s3Client.send(new ListBucketsCommand({}));
        const bucketNames = result.Buckets?.map(b => b.Name) || [];

        return {
          success: true,
          message: 'Connection successful',
          buckets: bucketNames,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : '';
        if (errMsg.includes('AccessDenied') || errMsg.includes('403')) {
          return reply.code(400).send({
            success: false,
            error: 'This appears to be a bucket-scoped key. Add bucket names in Global Spaces settings.',
            scopedKey: true,
          });
        }
        const message = error instanceof Error ? error.message : 'Connection test failed';
        return reply.code(400).send({
          success: false,
          error: message
        });
      }
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
    select: { sshPrivateKey: true },
  });

  if (!environment?.sshPrivateKey) {
    return null;
  }

  const [nonce, ciphertext] = environment.sshPrivateKey.split(':');
  const privateKey = decrypt(ciphertext, nonce);

  const generalSettings = await prisma.generalSettings.findUnique({
    where: { environmentId },
  });

  return {
    privateKey,
    username: generalSettings?.sshUser ?? 'root',
  };
}

// Helper to get Spaces credentials for an environment (uses global Spaces config)
export async function getEnvironmentSpacesConfig(environmentId: string): Promise<{
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
  buckets?: string[];
} | null> {
  // Check if global Spaces config exists and is enabled for this environment
  const globalConfig = await prisma.spacesConfig.findFirst({
    include: {
      enabledEnvironments: {
        where: { environmentId, enabled: true },
      },
    },
  });

  if (!globalConfig || globalConfig.enabledEnvironments.length === 0) {
    return null;
  }

  const secretKey = decrypt(globalConfig.encryptedSecretKey, globalConfig.secretKeyNonce);
  let buckets: string[] | undefined;
  if (globalConfig.buckets) {
    try {
      buckets = JSON.parse(globalConfig.buckets);
    } catch {
      buckets = undefined;
    }
  }

  return {
    accessKey: globalConfig.accessKey,
    secretKey,
    region: globalConfig.region,
    endpoint: globalConfig.endpoint,
    buckets,
  };
}
