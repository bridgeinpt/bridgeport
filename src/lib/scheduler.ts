import { prisma } from './db.js';
import { checkServerHealth, discoverContainers } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { RegistryFactory, type RegistryCredentials } from './registry.js';
import { getRegistryCredentials } from '../services/registries.js';
import { deployService } from '../services/deploy.js';
import { extractRepoName } from './image-utils.js';
import {
  collectServerMetricsSSH,
  collectServiceMetrics,
  saveServerMetrics,
  saveServiceMetrics,
  cleanupOldMetrics,
  collectServerDataSSH,
} from '../services/metrics.js';
import { checkDueBackups } from '../services/database-backup.js';

interface SchedulerConfig {
  serverHealthIntervalMs: number;
  serviceHealthIntervalMs: number;
  discoveryIntervalMs: number;
  updateCheckIntervalMs: number;
  metricsIntervalMs: number;
  backupCheckIntervalMs: number;
  metricsRetentionDays: number;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  serverHealthIntervalMs: 60 * 1000, // 1 minute
  serviceHealthIntervalMs: 60 * 1000, // 1 minute
  discoveryIntervalMs: 5 * 60 * 1000, // 5 minutes
  updateCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
  metricsIntervalMs: 5 * 60 * 1000, // 5 minutes
  backupCheckIntervalMs: 60 * 1000, // 1 minute
  metricsRetentionDays: 7,
};

const timers = new Map<string, NodeJS.Timeout>();
let isRunning = false;

/**
 * Run health checks on all servers (skips agent-mode servers since agents report health directly)
 */
async function runServerHealthChecks(): Promise<void> {
  try {
    const servers = await prisma.server.findMany({
      where: { metricsMode: { not: 'agent' } }, // Skip agent servers - they report health directly
      select: { id: true, name: true },
    });

    console.log(`[Scheduler] Running health checks on ${servers.length} servers (excluding agent-mode)`);

    for (const server of servers) {
      try {
        await checkServerHealth(server.id);
      } catch (error) {
        console.error(`[Scheduler] Health check failed for server ${server.name}:`, error);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Server health check run failed:', error);
  }
}

/**
 * Run health checks on all services that have a healthCheckUrl configured
 * (skips services on agent-mode servers since agents report container health directly)
 * Note: Services with healthCheckUrl on agent servers still need URL checks via SSH,
 * as the agent cannot perform HTTP health checks.
 */
async function runServiceHealthChecks(): Promise<void> {
  try {
    const services = await prisma.service.findMany({
      where: {
        healthCheckUrl: { not: null },
        discoveryStatus: 'found',
        // For agent-mode servers, we still need to do URL checks since the agent
        // cannot perform HTTP health checks. Include all services with healthCheckUrl.
      },
      select: { id: true, name: true },
    });

    console.log(`[Scheduler] Running health checks on ${services.length} services`);

    for (const service of services) {
      try {
        await checkServiceHealth(service.id);
      } catch (error) {
        console.error(`[Scheduler] Health check failed for service ${service.name}:`, error);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Service health check run failed:', error);
  }
}

/**
 * Run container discovery on all servers
 */
async function runDiscovery(): Promise<void> {
  try {
    const servers = await prisma.server.findMany({
      where: { status: 'healthy' }, // Only discover on healthy servers
      select: { id: true, name: true },
    });

    console.log(`[Scheduler] Running discovery on ${servers.length} healthy servers`);

    for (const server of servers) {
      try {
        await discoverContainers(server.id);
      } catch (error) {
        console.error(`[Scheduler] Discovery failed for server ${server.name}:`, error);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Discovery run failed:', error);
  }
}

/**
 * Check for updates on a single service
 */
async function checkServiceForUpdates(
  serviceId: string,
  creds: RegistryCredentials
): Promise<{ hasUpdate: boolean; latestTag?: string; latestDigest?: string }> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      id: true,
      name: true,
      imageName: true,
      imageTag: true,
      latestAvailableDigest: true,
    },
  });

  if (!service) {
    return { hasUpdate: false };
  }

  try {
    const client = RegistryFactory.create(creds);
    const repoName = extractRepoName(service.imageName, creds.repositoryPrefix);

    // Get the latest tag from the registry
    const latestTag = await client.getLatestTag(repoName);
    if (!latestTag) {
      return { hasUpdate: false };
    }

    // Also check the digest for the current tag (handles "latest" tag updates)
    let currentDigest: string | null = null;
    try {
      currentDigest = await client.getManifestDigest(repoName, service.imageTag);
    } catch {
      // If we can't get current digest, we'll compare by tag only
    }

    // Update the service with latest available info
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        latestAvailableTag: latestTag.tag,
        latestAvailableDigest: latestTag.digest,
        lastUpdateCheckAt: new Date(),
      },
    });

    // Determine if there's an update available
    // An update is available if:
    // 1. The latest tag is different from the current tag (e.g., new version)
    // 2. OR the digest for the current tag has changed (e.g., "latest" was updated)
    const hasUpdate =
      latestTag.tag !== service.imageTag ||
      (currentDigest !== null &&
        latestTag.digest !== service.latestAvailableDigest &&
        currentDigest !== latestTag.digest);

    return {
      hasUpdate,
      latestTag: latestTag.tag,
      latestDigest: latestTag.digest,
    };
  } catch (error) {
    console.error(`[Scheduler] Failed to check updates for ${service.name}:`, error);
    return { hasUpdate: false };
  }
}

/**
 * Run update checks on all services with registry connections
 */
async function runUpdateChecks(): Promise<void> {
  try {
    // Get all services that have a registry connection
    const services = await prisma.service.findMany({
      where: {
        registryConnectionId: { not: null },
        discoveryStatus: 'found',
      },
      select: {
        id: true,
        name: true,
        autoUpdate: true,
        registryConnectionId: true,
        imageTag: true,
        server: {
          select: {
            environment: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (services.length === 0) {
      console.log('[Scheduler] No services with registry connections to check');
      return;
    }

    console.log(`[Scheduler] Running update checks on ${services.length} services`);

    // Group services by registry connection to minimize API calls
    const byRegistry = new Map<string, typeof services>();
    for (const service of services) {
      const key = service.registryConnectionId!;
      if (!byRegistry.has(key)) {
        byRegistry.set(key, []);
      }
      byRegistry.get(key)!.push(service);
    }

    // Check updates for each registry
    for (const [registryId, registryServices] of byRegistry) {
      const creds = await getRegistryCredentials(registryId);
      if (!creds) {
        console.warn(`[Scheduler] Could not get credentials for registry ${registryId}`);
        continue;
      }

      for (const service of registryServices) {
        try {
          const result = await checkServiceForUpdates(service.id, creds);

          if (result.hasUpdate) {
            console.log(
              `[Scheduler] Update available for ${service.name}: ${service.imageTag} -> ${result.latestTag}`
            );

            // Auto-deploy if enabled
            if (service.autoUpdate && result.latestTag) {
              console.log(`[Scheduler] Auto-deploying ${service.name} to ${result.latestTag}`);
              try {
                await deployService(service.id, 'scheduler', null, {
                  imageTag: result.latestTag,
                  pullImage: true,
                });
                console.log(`[Scheduler] Auto-deploy successful for ${service.name}`);
              } catch (deployError) {
                console.error(`[Scheduler] Auto-deploy failed for ${service.name}:`, deployError);
              }
            }
          }
        } catch (error) {
          console.error(`[Scheduler] Update check failed for ${service.name}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[Scheduler] Update check run failed:', error);
  }
}

/**
 * Manually trigger update check for a specific service
 */
export async function checkServiceUpdate(serviceId: string): Promise<{
  hasUpdate: boolean;
  latestTag?: string;
  latestDigest?: string;
  error?: string;
}> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      id: true,
      registryConnectionId: true,
    },
  });

  if (!service) {
    return { hasUpdate: false, error: 'Service not found' };
  }

  if (!service.registryConnectionId) {
    return { hasUpdate: false, error: 'No registry connection configured' };
  }

  const creds = await getRegistryCredentials(service.registryConnectionId);
  if (!creds) {
    return { hasUpdate: false, error: 'Could not get registry credentials' };
  }

  return checkServiceForUpdates(serviceId, creds);
}

/**
 * Collect metrics and health from servers with SSH mode enabled.
 * Uses a single SSH connection per server to collect both server metrics,
 * service metrics, and health status (reducing duplicate SSH connections).
 */
async function runMetricsCollection(): Promise<void> {
  try {
    const servers = await prisma.server.findMany({
      where: {
        metricsMode: 'ssh',
      },
      include: {
        services: {
          where: { discoveryStatus: 'found' },
          select: { id: true, containerName: true },
        },
      },
    });

    if (servers.length === 0) {
      return; // No servers with SSH metrics enabled
    }

    console.log(`[Scheduler] Collecting metrics and health from ${servers.length} servers (SSH mode, combined)`);

    for (const server of servers) {
      try {
        // Collect all data in a single SSH session
        const data = await collectServerDataSSH(server.id);

        if (!data) {
          // Could not connect to server
          await prisma.server.update({
            where: { id: server.id },
            data: { status: 'unhealthy', lastCheckedAt: new Date() },
          });
          continue;
        }

        // Update server health status
        await prisma.server.update({
          where: { id: server.id },
          data: {
            status: data.serverHealth.status,
            lastCheckedAt: new Date(),
          },
        });

        // Save server metrics
        if (data.serverMetrics) {
          await saveServerMetrics(server.id, data.serverMetrics, 'ssh');
        }

        // Save service metrics and update health
        for (const serviceData of data.serviceData) {
          const service = server.services.find((s) => s.containerName === serviceData.containerName);
          if (!service) continue;

          // Save metrics
          if (serviceData.metrics) {
            await saveServiceMetrics(service.id, serviceData.metrics);
          }

          // Update service health status
          await prisma.service.update({
            where: { id: service.id },
            data: {
              status: serviceData.overallStatus,
              containerStatus: serviceData.containerStatus,
              healthStatus: serviceData.healthStatus,
              lastCheckedAt: new Date(),
            },
          });
        }
      } catch (error) {
        console.error(`[Scheduler] Combined metrics/health collection failed for server ${server.name}:`, error);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Combined metrics/health collection run failed:', error);
  }
}

/**
 * Check for due backup schedules and execute them
 */
async function runBackupChecks(): Promise<void> {
  try {
    await checkDueBackups();
  } catch (error) {
    console.error('[Scheduler] Backup check failed:', error);
  }
}

/**
 * Clean up old metrics data
 */
async function runMetricsCleanup(retentionDays: number): Promise<void> {
  try {
    const deleted = await cleanupOldMetrics(retentionDays);
    if (deleted > 0) {
      console.log(`[Scheduler] Cleaned up ${deleted} old metrics records`);
    }
  } catch (error) {
    console.error('[Scheduler] Metrics cleanup failed:', error);
  }
}

/**
 * Start the scheduler with periodic health checks and discovery
 */
export function startScheduler(config: Partial<SchedulerConfig> = {}): void {
  if (isRunning) {
    console.log('[Scheduler] Already running');
    return;
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };
  isRunning = true;

  console.log('[Scheduler] Starting with intervals:');
  console.log(`  - Server health: ${cfg.serverHealthIntervalMs / 1000}s`);
  console.log(`  - Service health: ${cfg.serviceHealthIntervalMs / 1000}s`);
  console.log(`  - Discovery: ${cfg.discoveryIntervalMs / 1000}s`);
  console.log(`  - Update checks: ${cfg.updateCheckIntervalMs / 1000}s`);
  console.log(`  - Metrics collection: ${cfg.metricsIntervalMs / 1000}s`);
  console.log(`  - Backup checks: ${cfg.backupCheckIntervalMs / 1000}s`);
  console.log(`  - Metrics retention: ${cfg.metricsRetentionDays} days`);

  // Run initial checks after a short delay
  setTimeout(() => {
    runServerHealthChecks();
  }, 5000);

  // Set up periodic timers
  timers.set('serverHealth', setInterval(runServerHealthChecks, cfg.serverHealthIntervalMs));
  timers.set('serviceHealth', setInterval(runServiceHealthChecks, cfg.serviceHealthIntervalMs));
  timers.set('discovery', setInterval(runDiscovery, cfg.discoveryIntervalMs));
  timers.set('updateCheck', setInterval(runUpdateChecks, cfg.updateCheckIntervalMs));
  timers.set('metrics', setInterval(runMetricsCollection, cfg.metricsIntervalMs));
  timers.set('backupCheck', setInterval(runBackupChecks, cfg.backupCheckIntervalMs));
  timers.set('cleanup', setInterval(() => runMetricsCleanup(cfg.metricsRetentionDays), 60 * 60 * 1000));
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (!isRunning) {
    return;
  }

  console.log('[Scheduler] Stopping');

  for (const timer of timers.values()) {
    clearInterval(timer);
  }
  timers.clear();

  isRunning = false;
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return isRunning;
}
