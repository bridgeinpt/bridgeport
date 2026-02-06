import { prisma } from '../lib/db.js';

/**
 * Log a health check result
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
  await prisma.healthCheckLog.create({
    data: params,
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
  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { schedulerConfig: true },
  });

  const stored = env?.schedulerConfig ? JSON.parse(env.schedulerConfig) : {};
  return { ...DEFAULT_SCHEDULER_CONFIG, ...stored };
}
