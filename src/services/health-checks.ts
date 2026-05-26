import { prisma } from '../lib/db.js';

/**
 * Log a health check result.
 *
 * Writes the full audit row to HealthCheckLog AND updates the denormalized
 * lastCheck* cache columns on the target Server or Service in a single
 * transaction, so GET /:envId/health-status can read current status directly
 * from the entity table instead of scanning the log.
 *
 * resourceType maps:
 *   - 'server'              -> Server.lastCheck*
 *   - 'service' | 'container' -> Service.lastCheck* (container checks target services)
 */
export async function logHealthCheck(params: {
  environmentId: string;
  resourceType: 'server' | 'service' | 'container';
  resourceId: string;
  resourceName: string;
  checkType: 'ssh' | 'url' | 'container_health' | 'discovery';
  status: 'success' | 'failure' | 'timeout';
  durationMs?: number;
  httpStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  const cacheUpdate = {
    lastCheckStatus: params.status,
    lastCheckAt: new Date(),
    lastCheckType: params.checkType,
    lastCheckDurationMs: params.durationMs ?? null,
    lastCheckError: params.errorMessage ?? null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.healthCheckLog.create({ data: params });

    if (params.resourceType === 'server') {
      await tx.server.updateMany({
        where: { id: params.resourceId },
        data: cacheUpdate,
      });
    } else {
      // Both 'service' and 'container' resourceTypes write to the Service entity.
      await tx.service.updateMany({
        where: { id: params.resourceId },
        data: cacheUpdate,
      });
    }
  });
}

/**
 * Clean up old health check logs based on retention days
 */
export async function cleanupHealthCheckLogs(retentionDays: number): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const result = await prisma.healthCheckLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
    },
  });

  return result.count;
}

// Default scheduler config values (per-environment)
export const DEFAULT_SCHEDULER_CONFIG = {
  serverHealthIntervalMs: 60000,
  serviceHealthIntervalMs: 60000,
  discoveryIntervalMs: 300000,
  metricsIntervalMs: 300000,
  updateCheckIntervalMs: 1800000,
  backupCheckIntervalMs: 60000,
  metricsRetentionDays: 7,
  healthLogRetentionDays: 30,
  bounceThreshold: 3,
  bounceCooldownMs: 900000,
  // Metrics collection toggles - all enabled by default
  collectCpu: true,
  collectMemory: true,
  collectSwap: true,
  collectDisk: true,
  collectLoad: true,
  collectFds: true,
  collectTcp: true,
  collectProcesses: true,
  collectTcpChecks: true,
  collectCertChecks: true,
};

export type EnvironmentSchedulerConfig = typeof DEFAULT_SCHEDULER_CONFIG;

/**
 * Get scheduler config for an environment (with defaults filled in)
 */
export async function getSchedulerConfig(environmentId: string): Promise<EnvironmentSchedulerConfig> {
  const settings = await prisma.monitoringSettings.findUnique({
    where: { environmentId },
  });

  if (!settings) {
    return { ...DEFAULT_SCHEDULER_CONFIG };
  }

  return {
    serverHealthIntervalMs: settings.serverHealthIntervalMs,
    serviceHealthIntervalMs: settings.serviceHealthIntervalMs,
    discoveryIntervalMs: settings.discoveryIntervalMs,
    metricsIntervalMs: settings.metricsIntervalMs,
    updateCheckIntervalMs: settings.updateCheckIntervalMs,
    backupCheckIntervalMs: settings.backupCheckIntervalMs,
    metricsRetentionDays: settings.metricsRetentionDays,
    healthLogRetentionDays: settings.healthLogRetentionDays,
    bounceThreshold: settings.bounceThreshold,
    bounceCooldownMs: settings.bounceCooldownMs,
    collectCpu: settings.collectCpu,
    collectMemory: settings.collectMemory,
    collectSwap: settings.collectSwap,
    collectDisk: settings.collectDisk,
    collectLoad: settings.collectLoad,
    collectFds: settings.collectFds,
    collectTcp: settings.collectTcp,
    collectProcesses: settings.collectProcesses,
    collectTcpChecks: settings.collectTcpChecks,
    collectCertChecks: settings.collectCertChecks,
  };
}
