import { prisma } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { executeMonitoringQueries, type MonitoringConfig, type SQLConnectionInfo, type SSHConnectionInfo, type RedisConnectionInfo } from './database-query-executor.js';
import { safeJsonParse } from '../lib/helpers.js';

/**
 * Collect metrics for a single database
 */
export async function collectDatabaseMetrics(databaseId: string): Promise<void> {
  const database = await prisma.database.findUnique({
    where: { id: databaseId },
    include: {
      databaseType: true,
      server: true,
    },
  });

  if (!database) {
    throw new Error(`Database not found: ${databaseId}`);
  }

  if (!database.monitoringEnabled) {
    return;
  }

  if (!database.databaseType?.monitoringConfig) {
    return; // No monitoring config defined for this database type
  }

  const monitoringConfig = safeJsonParse(database.databaseType.monitoringConfig, null) as MonitoringConfig | null;

  if (!monitoringConfig || !monitoringConfig.queries || monitoringConfig.queries.length === 0) {
    return;
  }

  // Decrypt credentials if present
  let credentials: { username?: string; password?: string } | undefined;
  if (database.encryptedCredentials && database.credentialsNonce) {
    const decrypted = decrypt(database.encryptedCredentials, database.credentialsNonce);
    if (decrypted.includes(':')) {
      const [username, ...rest] = decrypted.split(':');
      credentials = { username, password: rest.join(':') };
    } else {
      credentials = { password: decrypted };
    }
  }

  try {
    let sqlConn: SQLConnectionInfo | undefined;
    let sshConn: SSHConnectionInfo | undefined;
    let redisConn: RedisConnectionInfo | undefined;

    if (monitoringConfig.connectionMode === 'sql') {
      sqlConn = {
        host: database.host || 'localhost',
        port: database.port || (monitoringConfig.driver === 'pg' ? 5432 : 3306),
        database: database.databaseName || 'postgres',
        user: credentials?.username || 'postgres',
        password: credentials?.password,
        useSsl: database.useSsl,
      };
    } else if (monitoringConfig.connectionMode === 'ssh') {
      if (!database.server) {
        throw new Error('SSH monitoring requires a server');
      }

      const sshCreds = await getEnvironmentSshKey(database.environmentId);
      if (!sshCreds) {
        throw new Error('SSH key not configured for environment');
      }

      sshConn = {
        hostname: database.server.hostname,
        sshUser: sshCreds.username,
        sshPrivateKey: sshCreds.privateKey,
        filePath: database.filePath || undefined,
      };
    } else if (monitoringConfig.connectionMode === 'redis') {
      redisConn = {
        host: database.host || 'localhost',
        port: database.port || 6379,
        password: credentials?.password,
        useSsl: database.useSsl,
      };
    }

    const metricsResult = await executeMonitoringQueries(monitoringConfig, sqlConn, sshConn, redisConn);

    // Store metrics
    await prisma.databaseMetrics.create({
      data: {
        databaseId,
        metricsJson: JSON.stringify(metricsResult),
      },
    });

    // Update database status
    await prisma.database.update({
      where: { id: databaseId },
      data: {
        monitoringStatus: 'connected',
        lastCollectedAt: new Date(),
        lastMonitoringError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Collection failed';

    // Check if this is a transition to error
    const prevStatus = database.monitoringStatus;

    await prisma.database.update({
      where: { id: databaseId },
      data: {
        monitoringStatus: 'error',
        lastMonitoringError: message,
      },
    });

    // Only log on transition to error (not repeated errors)
    if (prevStatus !== 'error') {
      console.error(`[DatabaseMonitoring] Database "${database.name}" transitioned to error: ${message}`);
    }

    throw error;
  }
}

/**
 * Run metrics collection for all enabled databases
 * Called periodically by the scheduler
 */
export async function runDatabaseMetricsCollection(): Promise<void> {
  const databases = await prisma.database.findMany({
    where: { monitoringEnabled: true },
    select: {
      id: true,
      name: true,
      collectionIntervalSec: true,
      lastCollectedAt: true,
      databaseType: {
        select: { monitoringConfig: true },
      },
    },
  });

  if (databases.length === 0) {
    return;
  }

  // Filter to only databases with monitoring config defined
  const monitored = databases.filter(db => db.databaseType?.monitoringConfig);

  if (monitored.length === 0) {
    return;
  }

  console.log(`[Scheduler] Collecting metrics from ${monitored.length} database(s)`);

  const now = new Date();

  for (const database of monitored) {
    try {
      // Check if enough time has passed since last collection
      if (database.lastCollectedAt) {
        const elapsedMs = now.getTime() - database.lastCollectedAt.getTime();
        const intervalMs = database.collectionIntervalSec * 1000;

        if (elapsedMs < intervalMs) {
          continue;
        }
      }

      await collectDatabaseMetrics(database.id);
    } catch (error) {
      console.error(`[Scheduler] Database metrics collection failed for ${database.name}:`, error);
    }
  }
}

/**
 * Clean up old database metrics based on retention policy
 */
export async function cleanupOldDatabaseMetrics(retentionDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.databaseMetrics.deleteMany({
    where: {
      collectedAt: { lt: cutoffDate },
    },
  });

  return result.count;
}
