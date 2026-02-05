import { prisma } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { collectRedisMetrics } from './redis-collector.js';
import { collectPostgresMetrics } from './postgres-collector.js';
import { collectSqliteMetrics } from './sqlite-collector.js';

/**
 * Collect metrics for a single data store
 */
export async function collectDataStoreMetrics(dataStoreId: string): Promise<void> {
  const dataStore = await prisma.dataStore.findUnique({
    where: { id: dataStoreId },
    include: {
      server: true,
      environment: { select: { sshPrivateKey: true, sshUser: true } },
    },
  });

  if (!dataStore) {
    throw new Error(`Data store not found: ${dataStoreId}`);
  }

  if (!dataStore.enabled) {
    return; // Skip disabled data stores
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
        const metrics = await collectRedisMetrics({
          host: dataStore.host!,
          port: dataStore.port ?? 6379,
          password: credentials?.password,
          db: dataStore.redisDb ?? 0,
          isCluster: dataStore.isCluster,
          clusterNodes: dataStore.clusterNodes ? JSON.parse(dataStore.clusterNodes) : undefined,
        });
        metricsJson = JSON.stringify(metrics);
        break;
      }
      case 'postgres': {
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
        const metrics = await collectSqliteMetrics({
          filePath: dataStore.filePath!,
          server: dataStore.server,
          environment: dataStore.environment,
        });
        metricsJson = JSON.stringify(metrics);
        break;
      }
      default:
        throw new Error(`Unknown data store type: ${dataStore.type}`);
    }

    // Store metrics
    await prisma.dataStoreMetrics.create({
      data: {
        dataStoreId,
        metricsJson,
      },
    });

    // Update data store status
    await prisma.dataStore.update({
      where: { id: dataStoreId },
      data: {
        status: 'connected',
        lastCollectedAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Collection failed';

    await prisma.dataStore.update({
      where: { id: dataStoreId },
      data: {
        status: 'error',
        lastError: message,
      },
    });

    throw error;
  }
}

/**
 * Run metrics collection for all enabled data stores
 * Called periodically by the scheduler
 */
export async function runDataStoreMetricsCollection(): Promise<void> {
  const dataStores = await prisma.dataStore.findMany({
    where: { enabled: true },
    select: {
      id: true,
      name: true,
      type: true,
      collectionIntervalSec: true,
      lastCollectedAt: true,
    },
  });

  if (dataStores.length === 0) {
    return;
  }

  console.log(`[Scheduler] Collecting metrics from ${dataStores.length} data store(s)`);

  const now = new Date();

  for (const dataStore of dataStores) {
    try {
      // Check if enough time has passed since last collection
      if (dataStore.lastCollectedAt) {
        const elapsedMs = now.getTime() - dataStore.lastCollectedAt.getTime();
        const intervalMs = dataStore.collectionIntervalSec * 1000;

        if (elapsedMs < intervalMs) {
          // Skip - not enough time has passed
          continue;
        }
      }

      await collectDataStoreMetrics(dataStore.id);
    } catch (error) {
      console.error(`[Scheduler] Data store metrics collection failed for ${dataStore.name}:`, error);
    }
  }
}

/**
 * Clean up old data store metrics based on retention policy
 */
export async function cleanupOldDataStoreMetrics(retentionDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.dataStoreMetrics.deleteMany({
    where: {
      collectedAt: { lt: cutoffDate },
    },
  });

  return result.count;
}
