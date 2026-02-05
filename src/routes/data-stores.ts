import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logAudit } from '../services/audit.js';

const dataStoreTypeSchema = z.enum(['redis', 'postgres', 'sqlite']);

const createDataStoreSchema = z.object({
  name: z.string().min(1),
  type: dataStoreTypeSchema,
  // Connection details
  host: z.string().optional(),
  port: z.number().optional(),
  password: z.string().optional(), // Plain password, will be encrypted
  username: z.string().optional(), // For postgres
  databaseName: z.string().optional(), // For postgres
  redisDb: z.number().min(0).max(15).optional(), // For redis
  // For SQLite or SSH tunnel
  serverId: z.string().optional(),
  filePath: z.string().optional(),
  // Optional link to existing Database
  databaseId: z.string().optional(),
  // Monitoring config
  enabled: z.boolean().optional(),
  collectionIntervalSec: z.number().min(10).max(3600).optional(),
  // Redis cluster
  isCluster: z.boolean().optional(),
  clusterNodes: z.array(z.string()).optional(),
});

const updateDataStoreSchema = createDataStoreSchema.partial();

export async function dataStoreRoutes(fastify: FastifyInstance): Promise<void> {
  // List data stores for environment
  fastify.get(
    '/api/environments/:envId/data-stores',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const dataStores = await prisma.dataStore.findMany({
        where: { environmentId: envId },
        include: {
          server: { select: { id: true, name: true, hostname: true } },
          database: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      });

      // Get latest metrics for each data store
      const dataStoresWithMetrics = await Promise.all(
        dataStores.map(async (ds) => {
          const latestMetrics = await prisma.dataStoreMetrics.findFirst({
            where: { dataStoreId: ds.id },
            orderBy: { collectedAt: 'desc' },
          });

          return {
            ...ds,
            // Don't expose encrypted credentials
            encryptedCredentials: undefined,
            credentialsNonce: undefined,
            hasCredentials: !!ds.encryptedCredentials,
            latestMetrics: latestMetrics
              ? {
                  collectedAt: latestMetrics.collectedAt,
                  metrics: JSON.parse(latestMetrics.metricsJson),
                }
              : null,
          };
        })
      );

      return { dataStores: dataStoresWithMetrics };
    }
  );

  // Create data store
  fastify.post(
    '/api/environments/:envId/data-stores',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createDataStoreSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const { password, username, clusterNodes, ...rest } = body.data;

      // Encrypt credentials if provided
      let encryptedCredentials: string | undefined;
      let credentialsNonce: string | undefined;

      if (password) {
        const credentials = username ? `${username}:${password}` : password;
        const encrypted = encrypt(credentials);
        encryptedCredentials = encrypted.ciphertext;
        credentialsNonce = encrypted.nonce;
      }

      try {
        const dataStore = await prisma.dataStore.create({
          data: {
            ...rest,
            environmentId: envId,
            encryptedCredentials,
            credentialsNonce,
            clusterNodes: clusterNodes ? JSON.stringify(clusterNodes) : undefined,
          },
          include: {
            server: { select: { id: true, name: true, hostname: true } },
            database: { select: { id: true, name: true } },
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'data_store',
          resourceId: dataStore.id,
          resourceName: dataStore.name,
          details: { type: dataStore.type },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return {
          dataStore: {
            ...dataStore,
            encryptedCredentials: undefined,
            credentialsNonce: undefined,
            hasCredentials: !!encryptedCredentials,
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Data store with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Get data store
  fastify.get(
    '/api/data-stores/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const dataStore = await prisma.dataStore.findUnique({
        where: { id },
        include: {
          server: { select: { id: true, name: true, hostname: true } },
          database: { select: { id: true, name: true } },
        },
      });

      if (!dataStore) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      return {
        dataStore: {
          ...dataStore,
          encryptedCredentials: undefined,
          credentialsNonce: undefined,
          hasCredentials: !!dataStore.encryptedCredentials,
        },
      };
    }
  );

  // Update data store
  fastify.patch(
    '/api/data-stores/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateDataStoreSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.dataStore.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      const { password, username, clusterNodes, ...rest } = body.data;

      // Encrypt new credentials if provided
      let encryptedCredentials: string | undefined;
      let credentialsNonce: string | undefined;

      if (password !== undefined) {
        if (password) {
          const credentials = username ? `${username}:${password}` : password;
          const encrypted = encrypt(credentials);
          encryptedCredentials = encrypted.ciphertext;
          credentialsNonce = encrypted.nonce;
        } else {
          // Clear credentials if empty password
          encryptedCredentials = null as unknown as undefined;
          credentialsNonce = null as unknown as undefined;
        }
      }

      const updateData: Record<string, unknown> = { ...rest };
      if (encryptedCredentials !== undefined) {
        updateData.encryptedCredentials = encryptedCredentials;
        updateData.credentialsNonce = credentialsNonce;
      }
      if (clusterNodes !== undefined) {
        updateData.clusterNodes = clusterNodes ? JSON.stringify(clusterNodes) : null;
      }

      const dataStore = await prisma.dataStore.update({
        where: { id },
        data: updateData,
        include: {
          server: { select: { id: true, name: true, hostname: true } },
          database: { select: { id: true, name: true } },
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'data_store',
        resourceId: dataStore.id,
        resourceName: dataStore.name,
        details: { changes: Object.keys(body.data) },
        userId: request.authUser!.id,
        environmentId: existing.environmentId,
      });

      return {
        dataStore: {
          ...dataStore,
          encryptedCredentials: undefined,
          credentialsNonce: undefined,
          hasCredentials: !!dataStore.encryptedCredentials,
        },
      };
    }
  );

  // Delete data store
  fastify.delete(
    '/api/data-stores/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await prisma.dataStore.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      await prisma.dataStore.delete({ where: { id } });

      await logAudit({
        action: 'delete',
        resourceType: 'data_store',
        resourceId: id,
        resourceName: existing.name,
        userId: request.authUser!.id,
        environmentId: existing.environmentId,
      });

      return { success: true };
    }
  );

  // Test connection
  fastify.post(
    '/api/data-stores/:id/test-connection',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const dataStore = await prisma.dataStore.findUnique({
        where: { id },
        include: {
          server: true,
          environment: { select: { sshPrivateKey: true, sshUser: true } },
        },
      });

      if (!dataStore) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      // Decrypt credentials if present
      let credentials: { username?: string; password?: string } | undefined;
      if (dataStore.encryptedCredentials && dataStore.credentialsNonce) {
        const decrypted = decrypt(dataStore.encryptedCredentials, dataStore.credentialsNonce);
        if (decrypted.includes(':')) {
          const [username, password] = decrypted.split(':');
          credentials = { username, password };
        } else {
          credentials = { password: decrypted };
        }
      }

      // Dynamic import of collector based on type
      try {
        let result: { success: boolean; message: string; details?: unknown };

        switch (dataStore.type) {
          case 'redis': {
            const { testRedisConnection } = await import('../services/redis-collector.js');
            result = await testRedisConnection({
              host: dataStore.host!,
              port: dataStore.port ?? 6379,
              password: credentials?.password,
              db: dataStore.redisDb ?? 0,
              isCluster: dataStore.isCluster,
              clusterNodes: dataStore.clusterNodes
                ? JSON.parse(dataStore.clusterNodes)
                : undefined,
            });
            break;
          }
          case 'postgres': {
            const { testPostgresConnection } = await import('../services/postgres-collector.js');
            result = await testPostgresConnection({
              host: dataStore.host!,
              port: dataStore.port ?? 5432,
              database: dataStore.databaseName ?? 'postgres',
              username: credentials?.username ?? 'postgres',
              password: credentials?.password,
            });
            break;
          }
          case 'sqlite': {
            const { testSqliteConnection } = await import('../services/sqlite-collector.js');
            result = await testSqliteConnection({
              filePath: dataStore.filePath!,
              server: dataStore.server,
              environment: dataStore.environment,
            });
            break;
          }
          default:
            return reply.code(400).send({ error: `Unknown data store type: ${dataStore.type}` });
        }

        // Update status based on test result
        await prisma.dataStore.update({
          where: { id },
          data: {
            status: result.success ? 'connected' : 'error',
            lastError: result.success ? null : result.message,
          },
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection test failed';

        await prisma.dataStore.update({
          where: { id },
          data: { status: 'error', lastError: message },
        });

        return { success: false, message };
      }
    }
  );

  // Get metrics for a data store
  fastify.get(
    '/api/data-stores/:id/metrics',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { from, to, limit } = request.query as {
        from?: string;
        to?: string;
        limit?: string;
      };

      const dataStore = await prisma.dataStore.findUnique({ where: { id } });
      if (!dataStore) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      const where: Record<string, unknown> = { dataStoreId: id };

      if (from || to) {
        where.collectedAt = {};
        if (from) {
          (where.collectedAt as Record<string, Date>).gte = new Date(from);
        }
        if (to) {
          (where.collectedAt as Record<string, Date>).lte = new Date(to);
        }
      }

      const metrics = await prisma.dataStoreMetrics.findMany({
        where,
        orderBy: { collectedAt: 'desc' },
        take: limit ? parseInt(limit) : 100,
      });

      return {
        metrics: metrics.map((m) => ({
          id: m.id,
          collectedAt: m.collectedAt,
          metrics: JSON.parse(m.metricsJson),
        })),
      };
    }
  );

  // Trigger manual collection
  fastify.post(
    '/api/data-stores/:id/collect',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const dataStore = await prisma.dataStore.findUnique({
        where: { id },
        include: {
          server: true,
          environment: { select: { sshPrivateKey: true, sshUser: true } },
        },
      });

      if (!dataStore) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      // Decrypt credentials if present
      let credentials: { username?: string; password?: string } | undefined;
      if (dataStore.encryptedCredentials && dataStore.credentialsNonce) {
        const decrypted = decrypt(dataStore.encryptedCredentials, dataStore.credentialsNonce);
        if (decrypted.includes(':')) {
          const [username, password] = decrypted.split(':');
          credentials = { username, password };
        } else {
          credentials = { password: decrypted };
        }
      }

      try {
        let metricsJson: string;

        switch (dataStore.type) {
          case 'redis': {
            const { collectRedisMetrics } = await import('../services/redis-collector.js');
            const metrics = await collectRedisMetrics({
              host: dataStore.host!,
              port: dataStore.port ?? 6379,
              password: credentials?.password,
              db: dataStore.redisDb ?? 0,
              isCluster: dataStore.isCluster,
              clusterNodes: dataStore.clusterNodes
                ? JSON.parse(dataStore.clusterNodes)
                : undefined,
            });
            metricsJson = JSON.stringify(metrics);
            break;
          }
          case 'postgres': {
            const { collectPostgresMetrics } = await import('../services/postgres-collector.js');
            const metrics = await collectPostgresMetrics({
              host: dataStore.host!,
              port: dataStore.port ?? 5432,
              database: dataStore.databaseName ?? 'postgres',
              username: credentials?.username ?? 'postgres',
              password: credentials?.password,
            });
            metricsJson = JSON.stringify(metrics);
            break;
          }
          case 'sqlite': {
            const { collectSqliteMetrics } = await import('../services/sqlite-collector.js');
            const metrics = await collectSqliteMetrics({
              filePath: dataStore.filePath!,
              server: dataStore.server,
              environment: dataStore.environment,
            });
            metricsJson = JSON.stringify(metrics);
            break;
          }
          default:
            return reply.code(400).send({ error: `Unknown data store type: ${dataStore.type}` });
        }

        // Store metrics
        const stored = await prisma.dataStoreMetrics.create({
          data: {
            dataStoreId: id,
            metricsJson,
          },
        });

        // Update data store status
        await prisma.dataStore.update({
          where: { id },
          data: {
            status: 'connected',
            lastCollectedAt: new Date(),
            lastError: null,
          },
        });

        return {
          success: true,
          metrics: {
            id: stored.id,
            collectedAt: stored.collectedAt,
            metrics: JSON.parse(metricsJson),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Collection failed';

        await prisma.dataStore.update({
          where: { id },
          data: { status: 'error', lastError: message },
        });

        return reply.code(500).send({ success: false, error: message });
      }
    }
  );

  // Discover Redis cluster nodes
  fastify.post(
    '/api/data-stores/:id/discover-cluster',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const dataStore = await prisma.dataStore.findUnique({ where: { id } });

      if (!dataStore) {
        return reply.code(404).send({ error: 'Data store not found' });
      }

      if (dataStore.type !== 'redis') {
        return reply.code(400).send({ error: 'Cluster discovery only available for Redis' });
      }

      // Decrypt credentials if present
      let password: string | undefined;
      if (dataStore.encryptedCredentials && dataStore.credentialsNonce) {
        const decrypted = decrypt(dataStore.encryptedCredentials, dataStore.credentialsNonce);
        password = decrypted.includes(':') ? decrypted.split(':')[1] : decrypted;
      }

      try {
        const { discoverRedisCluster } = await import('../services/redis-collector.js');
        const result = await discoverRedisCluster({
          host: dataStore.host!,
          port: dataStore.port ?? 6379,
          password,
        });

        if (result.isCluster && result.nodes) {
          // Update data store with cluster info
          await prisma.dataStore.update({
            where: { id },
            data: {
              isCluster: true,
              clusterNodes: JSON.stringify(result.nodes),
            },
          });
        }

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cluster discovery failed';
        return reply.code(500).send({ success: false, error: message });
      }
    }
  );
}
