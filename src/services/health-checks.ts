import { prisma } from '../lib/db.js';

/**
 * Log a health check result.
 *
 * Writes the full audit row to HealthCheckLog AND (for 'server' and
 * 'service_deployment' resourceTypes only) updates the denormalized
 * lastHealthCheck* cache columns on the target entity in a single transaction,
 * so GET /:envId/health-status can read current status directly from the
 * entity table instead of scanning the log.
 *
 * resourceType maps:
 *   - 'server'             -> Server.lastHealthCheck*
 *   - 'service_deployment' -> ServiceDeployment.lastHealthCheck*
 *   - 'container'          -> log only (NO cache update). Container runtime
 *                             checks would otherwise clobber the URL probe
 *                             result the dashboard surfaces — see Finding 1
 *                             in PR #147.
 */
export async function logHealthCheck(params: {
  environmentId: string;
  resourceType: 'server' | 'service' | 'service_deployment' | 'container';
  resourceId: string;
  resourceName: string;
  checkType: 'ssh' | 'url' | 'container_health' | 'discovery';
  status: 'success' | 'failure' | 'timeout';
  durationMs?: number;
  httpStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.healthCheckLog.create({ data: params });

    // Build the cache row INSIDE the transaction so `lastHealthCheckAt` reflects
    // commit-order intent. Capturing `new Date()` before $transaction opens lets
    // an older capture race ahead of a newer one under overlapping ticks and
    // overwrite the newer cache value with a stale timestamp.
    const cacheUpdate = {
      lastHealthCheckStatus: params.status,
      lastHealthCheckAt: new Date(),
      lastHealthCheckType: params.checkType,
      lastHealthCheckDurationMs: params.durationMs ?? null,
      lastHealthCheckError: params.errorMessage ?? null,
    };

    if (params.resourceType === 'server') {
      await tx.server.updateMany({
        where: { id: params.resourceId },
        data: cacheUpdate,
      });
    } else if (params.resourceType === 'service_deployment') {
      await tx.serviceDeployment.updateMany({
        where: { id: params.resourceId },
        data: cacheUpdate,
      });
    }
    // 'container' (and any other resourceType) logs to HealthCheckLog but
    // does NOT touch the denormalized cache — the dashboard reflects the
    // URL/SSH health check, not the container runtime state, matching the
    // pre-PR behavior.
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

// Default scheduler config values (per-environment).
// Only the agent-facing metrics-collection toggles live here; the sole consumer
// (src/routes/metrics.ts, the Go-agent config payload) reads just these fields.
export const DEFAULT_SCHEDULER_CONFIG = {
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
