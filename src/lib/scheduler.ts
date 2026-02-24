import { captureException } from './sentry.js';
import { prisma } from './db.js';
import { checkServerHealth, discoverContainers } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { RegistryFactory, type RegistryCredentials } from './registry.js';
import { getRegistryCredentials } from '../services/registries.js';
import { deployService } from '../services/deploy.js';
import { extractRepoName } from './image-utils.js';
import { detectUpdate } from '../services/image-management.js';
import {
  collectServerMetricsSSH,
  saveServerMetrics,
  cleanupOldMetrics,
  collectServerDataSSH,
} from '../services/metrics.js';
import { checkDueBackups } from '../services/database-backup.js';
import { sendSystemNotification, NOTIFICATION_TYPES, cleanupOldNotifications } from '../services/notifications.js';
import pLimit from 'p-limit';
import { recordFailure, recordSuccess } from '../services/bounce-tracker.js';
import { buildDeploymentPlan, executePlan } from '../services/orchestration.js';
import { logHealthCheck, cleanupHealthCheckLogs } from '../services/health-checks.js';
import { getSystemSettings } from '../services/system-settings.js';
import { cleanupOldAuditLogs } from '../services/audit.js';
import { logAgentEvent } from '../services/agent-events.js';
import { runDatabaseMetricsCollection, cleanupOldDatabaseMetrics } from '../services/database-monitoring-collector.js';
import { eventBus } from './event-bus.js';

interface GlobalSchedulerConfig {
  serverHealthIntervalMs: number;
  serviceHealthIntervalMs: number;
  discoveryIntervalMs: number;
  updateCheckIntervalMs: number;
  metricsIntervalMs: number;
  backupCheckIntervalMs: number;
  databaseMetricsIntervalMs: number;
  metricsRetentionDays: number;
  notificationRetentionDays: number;
  healthLogRetentionDays: number;
}

const DEFAULT_CONFIG: GlobalSchedulerConfig = {
  serverHealthIntervalMs: 60 * 1000, // 1 minute
  serviceHealthIntervalMs: 60 * 1000, // 1 minute
  discoveryIntervalMs: 5 * 60 * 1000, // 5 minutes
  updateCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
  metricsIntervalMs: 5 * 60 * 1000, // 5 minutes
  backupCheckIntervalMs: 60 * 1000, // 1 minute
  databaseMetricsIntervalMs: 60 * 1000, // 1 minute (individual intervals are per-database)
  metricsRetentionDays: 7,
  notificationRetentionDays: 30,
  healthLogRetentionDays: 30,
};

const timers = new Map<string, NodeJS.Timeout>();
let isRunning = false;

// Concurrency limit for parallel operations (SSH connections, health checks)
const concurrencyLimit = pLimit(5);

/**
 * Fire-and-forget notification delivery — logs errors but doesn't block the caller.
 */
function notifyAsync(
  typeCode: Parameters<typeof sendSystemNotification>[0],
  environmentId: Parameters<typeof sendSystemNotification>[1],
  data: Parameters<typeof sendSystemNotification>[2]
): void {
  sendSystemNotification(typeCode, environmentId, data).catch((err) => {
    console.error('[Scheduler] Async notification delivery failed:', err);
  });
}

/**
 * Run health checks on all servers (skips agent-mode servers since agents report health directly)
 */
async function runServerHealthChecks(): Promise<void> {
  try {
    const servers = await prisma.server.findMany({
      where: { metricsMode: { not: 'agent' } }, // Skip agent servers - they report health directly
      select: { id: true, name: true, status: true, environmentId: true },
    });

    console.log(`[Scheduler] Running health checks on ${servers.length} servers (excluding agent-mode)`);

    await Promise.allSettled(servers.map((server) => concurrencyLimit(async () => {
      const start = Date.now();
      try {
        const prevStatus = server.status;
        await checkServerHealth(server.id);
        const durationMs = Date.now() - start;

        // Get updated status
        const updated = await prisma.server.findUnique({
          where: { id: server.id },
          select: { status: true },
        });

        // Log health check result
        await logHealthCheck({
          environmentId: server.environmentId,
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          checkType: 'ssh',
          status: updated?.status === 'healthy' ? 'success' : 'failure',
          durationMs,
        });

        if (updated) {
          if (updated.status !== prevStatus) {
            eventBus.emitEvent({ type: 'health_status', data: { resourceType: 'server', resourceId: server.id, status: updated.status, environmentId: server.environmentId } });
          }

          if (updated.status === 'unhealthy' && prevStatus !== 'unhealthy') {
            // Server became unhealthy - use bounce tracking
            const bounce = await recordFailure('server', server.id, 'offline', NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE);
            if (bounce.shouldAlert) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE,
                server.environmentId,
                { serverName: server.name }
              );
            }
          } else if (updated.status === 'healthy' && prevStatus === 'unhealthy') {
            // Server recovered
            const bounce = await recordSuccess('server', server.id, 'offline');
            if (bounce.wasRecovered) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_SERVER_ONLINE,
                server.environmentId,
                { serverName: server.name }
              );
            }
          }
        }
      } catch (error) {
        const durationMs = Date.now() - start;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Log failed health check
        await logHealthCheck({
          environmentId: server.environmentId,
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          checkType: 'ssh',
          status: 'failure',
          durationMs,
          errorMessage,
        });

        console.error(`[Scheduler] Health check failed for server ${server.name}:`, error);
      }
    })));
  } catch (error) {
    captureException(error, { scheduler: 'serverHealthChecks' });
    console.error('[Scheduler] Server health check run failed:', error);
  }
}

/**
 * Run health checks on all services that have a healthCheckUrl configured
 * Skips services on agent-mode servers since agents now perform URL health checks
 */
async function runServiceHealthChecks(): Promise<void> {
  try {
    const services = await prisma.service.findMany({
      where: {
        healthCheckUrl: { not: null },
        discoveryStatus: 'found',
        // Skip agent-mode servers - agents now perform health checks
        server: {
          metricsMode: { not: 'agent' },
        },
      },
      select: {
        id: true,
        name: true,
        server: { select: { environmentId: true, metricsMode: true } },
      },
    });

    console.log(`[Scheduler] Running health checks on ${services.length} services`);

    await Promise.allSettled(services.map((service) => concurrencyLimit(async () => {
      const start = Date.now();
      try {
        const result = await checkServiceHealth(service.id);
        const durationMs = Date.now() - start;

        // Determine if health check was successful
        const isHealthy = result.container.running && (result.url === null || result.url.success);

        // Build error message based on what failed
        let errorMessage: string | undefined;
        if (!isHealthy) {
          if (!result.container.running) {
            errorMessage = `Container not running (state: ${result.container.state})`;
          } else if (result.url && !result.url.success) {
            errorMessage = result.url.error || `HTTP ${result.url.statusCode}`;
          }
        }

        // Log health check result
        await logHealthCheck({
          environmentId: service.server.environmentId,
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          checkType: 'url',
          status: isHealthy ? 'success' : 'failure',
          durationMs,
          httpStatus: result.url?.statusCode,
          errorMessage,
        });
      } catch (error) {
        const durationMs = Date.now() - start;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Log failed health check
        await logHealthCheck({
          environmentId: service.server.environmentId,
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          checkType: 'url',
          status: 'failure',
          durationMs,
          errorMessage,
        });

        console.error(`[Scheduler] Health check failed for service ${service.name}:`, error);
      }
    })));
  } catch (error) {
    captureException(error, { scheduler: 'serviceHealthChecks' });
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
      select: { id: true, name: true, environmentId: true },
    });

    console.log(`[Scheduler] Running discovery on ${servers.length} healthy servers`);

    await Promise.allSettled(servers.map((server) => concurrencyLimit(async () => {
      try {
        await discoverContainers(server.id);
        eventBus.emitEvent({ type: 'container_discovery', data: { serverId: server.id, environmentId: server.environmentId } });
      } catch (error) {
        console.error(`[Scheduler] Discovery failed for server ${server.name}:`, error);
      }
    })));
  } catch (error) {
    captureException(error, { scheduler: 'discovery' });
    console.error('[Scheduler] Discovery run failed:', error);
  }
}

/**
 * Check for updates on a container image using shared detectUpdate logic
 */
async function checkImageForUpdates(
  imageId: string,
  imageName: string,
  currentTag: string,
  deployedDigest: string | null,
  creds: RegistryCredentials
): Promise<{ hasUpdate: boolean; latestTag?: string; latestDigest?: string }> {
  try {
    const client = RegistryFactory.create(creds);
    const repoName = extractRepoName(imageName, creds.repositoryPrefix);

    const allTags = await client.listTags(repoName);
    const result = await detectUpdate(imageId, currentTag, deployedDigest, allTags);
    return {
      hasUpdate: result.hasUpdate,
      latestTag: result.latestTag ?? undefined,
      latestDigest: result.latestDigest ?? undefined,
    };
  } catch (error) {
    console.error(`[Scheduler] Failed to check updates for image ${imageName}:`, error);
    return { hasUpdate: false };
  }
}

/**
 * Run update checks on all container images with registry connections
 * Auto-update is now controlled at the ContainerImage level
 */
async function runUpdateChecks(): Promise<void> {
  try {
    // Get all container images with registry connections
    const containerImages = await prisma.containerImage.findMany({
      where: {
        registryConnectionId: { not: null },
      },
      select: {
        id: true,
        name: true,
        imageName: true,
        currentTag: true,
        latestDigest: true,
        deployedDigest: true,
        autoUpdate: true,
        registryConnectionId: true,
        environmentId: true,
        services: {
          where: { discoveryStatus: 'found' },
          select: {
            id: true,
            name: true,
            imageTag: true,
          },
        },
      },
    });

    if (containerImages.length === 0) {
      console.log('[Scheduler] No container images with registry connections to check');
      return;
    }

    console.log(`[Scheduler] Running update checks on ${containerImages.length} container images`);

    // Group by registry connection to minimize API calls
    const byRegistry = new Map<string, typeof containerImages>();
    for (const image of containerImages) {
      const key = image.registryConnectionId;
      if (!key) continue;
      if (!byRegistry.has(key)) {
        byRegistry.set(key, []);
      }
      byRegistry.get(key)!.push(image);
    }

    // Check updates for each registry
    for (const [registryId, registryImages] of byRegistry) {
      const creds = await getRegistryCredentials(registryId);
      if (!creds) {
        console.warn(`[Scheduler] Could not get credentials for registry ${registryId}`);
        continue;
      }

      for (const image of registryImages) {
        // Skip images with no linked services
        if (image.services.length === 0) continue;

        try {
          const result = await checkImageForUpdates(
            image.id,
            image.imageName,
            image.currentTag,
            image.deployedDigest,
            creds
          );

          if (result.hasUpdate) {
            console.log(
              `[Scheduler] Update available for ${image.name}: ${image.currentTag} -> ${result.latestTag}`
            );

            // Auto-deploy if enabled — fire-and-forget to avoid blocking remaining image checks
            if (image.autoUpdate && result.latestTag) {
              console.log(`[Scheduler] Auto-deploying container image "${image.name}" to ${result.latestTag}`);
              const tag = result.latestTag;
              buildDeploymentPlan({
                environmentId: image.environmentId,
                containerImageId: image.id,
                imageTag: tag,
                triggeredBy: 'scheduler',
                triggerType: 'auto_update',
              })
                .then((plan) => executePlan(plan.id))
                .then(() => console.log(`[Scheduler] Auto-deploy successful for container image "${image.name}"`))
                .catch((deployError) => console.error(`[Scheduler] Auto-deploy failed for container image "${image.name}":`, deployError));
            }
          }
        } catch (error) {
          console.error(`[Scheduler] Update check failed for container image ${image.name}:`, error);
        }
      }
    }
  } catch (error) {
    captureException(error, { scheduler: 'updateChecks' });
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
    include: {
      containerImage: {
        select: {
          id: true,
          imageName: true,
          currentTag: true,
          deployedDigest: true,
          registryConnectionId: true,
        },
      },
    },
  });

  if (!service) {
    return { hasUpdate: false, error: 'Service not found' };
  }

  if (!service.containerImage?.registryConnectionId) {
    return { hasUpdate: false, error: 'No registry connection configured' };
  }

  const creds = await getRegistryCredentials(service.containerImage.registryConnectionId);
  if (!creds) {
    return { hasUpdate: false, error: 'Could not get registry credentials' };
  }

  return checkImageForUpdates(
    service.containerImage.id,
    service.containerImage.imageName,
    service.containerImage.currentTag,
    service.containerImage.deployedDigest,
    creds
  );
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

    await Promise.allSettled(servers.map((server) => concurrencyLimit(async () => {
      try {
        // Collect all data in a single SSH session
        const data = await collectServerDataSSH(server.id);

        if (!data) {
          // Could not connect to server
          await prisma.server.update({
            where: { id: server.id },
            data: { status: 'unhealthy', lastCheckedAt: new Date() },
          });
          return;
        }

        // Get previous status for comparison
        const prevServerStatus = server.status;

        // Update server health status
        await prisma.server.update({
          where: { id: server.id },
          data: {
            status: data.serverHealth.status,
            lastCheckedAt: new Date(),
          },
        });

        // Emit health_status event on server status change
        if (data.serverHealth.status !== prevServerStatus) {
          eventBus.emitEvent({ type: 'health_status', data: { resourceType: 'server', resourceId: server.id, status: data.serverHealth.status, environmentId: server.environmentId } });
        }

        // Handle server status changes
        if (data.serverHealth.status === 'unhealthy' && prevServerStatus !== 'unhealthy') {
          const bounce = await recordFailure('server', server.id, 'offline', NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE);
          if (bounce.shouldAlert) {
            notifyAsync(
              NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE,
              server.environmentId,
              { serverName: server.name }
            );
          }
        } else if (data.serverHealth.status === 'healthy' && prevServerStatus === 'unhealthy') {
          const bounce = await recordSuccess('server', server.id, 'offline');
          if (bounce.wasRecovered) {
            notifyAsync(
              NOTIFICATION_TYPES.SYSTEM_SERVER_ONLINE,
              server.environmentId,
              { serverName: server.name }
            );
          }
        }

        // Save server metrics
        if (data.serverMetrics) {
          await saveServerMetrics(server.id, data.serverMetrics, 'ssh');
          eventBus.emitEvent({ type: 'metrics_updated', data: { serverId: server.id, environmentId: server.environmentId } });
        }

        // Update service health status (service metrics are agent-only now)
        for (const serviceData of data.serviceData) {
          const service = server.services.find((s) => s.containerName === serviceData.containerName);
          if (!service) continue;

          // Get previous status for comparison
          const prevService = await prisma.service.findUnique({
            where: { id: service.id },
            select: { containerStatus: true, healthStatus: true },
          });

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

          // Emit health_status event for service status changes
          if (serviceData.overallStatus !== prevService?.containerStatus) {
            eventBus.emitEvent({ type: 'health_status', data: { resourceType: 'service', resourceId: service.id, status: serviceData.overallStatus, environmentId: server.environmentId } });
          }

          // Log container health check result
          const containerHealthy = serviceData.containerStatus === 'running' &&
            serviceData.healthStatus !== 'unhealthy';
          await logHealthCheck({
            environmentId: server.environmentId,
            resourceType: 'container',
            resourceId: service.id,
            resourceName: service.containerName,
            checkType: 'container_health',
            status: containerHealthy ? 'success' : 'failure',
            errorMessage: !containerHealthy
              ? `Container status: ${serviceData.containerStatus}, health: ${serviceData.healthStatus}`
              : undefined,
          });

          // Handle container status changes (crash detection)
          const crashStates = ['exited', 'dead'];
          const wasCrashed = prevService && crashStates.includes(prevService.containerStatus);
          const isCrashed = crashStates.includes(serviceData.containerStatus);
          const isRunning = serviceData.containerStatus === 'running';

          if (isCrashed && !wasCrashed) {
            // Container crashed
            const bounce = await recordFailure('service', service.id, 'crash', NOTIFICATION_TYPES.SYSTEM_CONTAINER_CRASH);
            if (bounce.shouldAlert) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_CONTAINER_CRASH,
                server.environmentId,
                { containerName: service.containerName, serverName: server.name }
              );
            }
          } else if (isRunning && wasCrashed) {
            // Container recovered
            const bounce = await recordSuccess('service', service.id, 'crash');
            if (bounce.wasRecovered) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_CONTAINER_RECOVERED,
                server.environmentId,
                { containerName: service.containerName, serverName: server.name }
              );
            }
          }

          // Handle health check status changes
          if (serviceData.healthStatus === 'unhealthy' && prevService?.healthStatus !== 'unhealthy') {
            const bounce = await recordFailure('service', service.id, 'health_check', NOTIFICATION_TYPES.SYSTEM_HEALTH_CHECK_FAILED);
            if (bounce.shouldAlert) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_HEALTH_CHECK_FAILED,
                server.environmentId,
                {
                  resourceType: 'Service',
                  resourceName: service.containerName,
                  error: 'Health check failed',
                }
              );
            }
          } else if (serviceData.healthStatus === 'healthy' && prevService?.healthStatus === 'unhealthy') {
            const bounce = await recordSuccess('service', service.id, 'health_check');
            if (bounce.wasRecovered) {
              notifyAsync(
                NOTIFICATION_TYPES.SYSTEM_HEALTH_CHECK_RECOVERED,
                server.environmentId,
                { resourceType: 'Service', resourceName: service.containerName }
              );
            }
          }
        }
      } catch (error) {
        console.error(`[Scheduler] Combined metrics/health collection failed for server ${server.name}:`, error);
      }
    })));
  } catch (error) {
    captureException(error, { scheduler: 'metricsCollection' });
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
    captureException(error, { scheduler: 'backupChecks' });
    console.error('[Scheduler] Backup check failed:', error);
  }
}

/**
 * Check for stale/offline agents and update their status
 */
async function runAgentStalenessCheck(): Promise<void> {
  try {
    const settings = await getSystemSettings();
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - settings.agentStaleThresholdMs);
    const offlineThreshold = new Date(now.getTime() - settings.agentOfflineThresholdMs);

    // Find all agent-mode servers with lastAgentPushAt set
    const agentServers = await prisma.server.findMany({
      where: {
        metricsMode: 'agent',
        lastAgentPushAt: { not: null },
        // Only check servers that are currently active or stale (not already offline)
        agentStatus: { in: ['active', 'stale', 'waiting'] },
      },
      select: {
        id: true,
        name: true,
        agentStatus: true,
        lastAgentPushAt: true,
        agentStatusChangedAt: true,
        environmentId: true,
      },
    });

    for (const server of agentServers) {
      if (!server.lastAgentPushAt) continue;

      const lastPush = new Date(server.lastAgentPushAt);
      let newStatus: string | null = null;

      if (lastPush < offlineThreshold) {
        // Agent is offline (exceeds offline threshold)
        if (server.agentStatus !== 'offline') {
          newStatus = 'offline';

          // Log status_change event
          await logAgentEvent({
            serverId: server.id,
            eventType: 'status_change',
            status: 'offline',
            message: 'Agent stopped reporting',
            details: { previousStatus: server.agentStatus, lastPush: server.lastAgentPushAt },
          });

          // Send notification for agent going offline
          const bounce = await recordFailure('server', server.id, 'offline', NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE);
          if (bounce.shouldAlert) {
            notifyAsync(
              NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE,
              server.environmentId,
              { serverName: server.name, reason: 'Agent stopped reporting' }
            );
          }
        }
      } else if (lastPush < staleThreshold) {
        // Agent is stale (exceeds stale threshold but not offline)
        if (server.agentStatus === 'active') {
          newStatus = 'stale';

          // Log status_change event
          await logAgentEvent({
            serverId: server.id,
            eventType: 'status_change',
            status: 'stale',
            message: 'Agent not reporting recently',
            details: { previousStatus: server.agentStatus, lastPush: server.lastAgentPushAt },
          });
        }
      }

      if (newStatus) {
        await prisma.server.update({
          where: { id: server.id },
          data: { agentStatus: newStatus, agentStatusChangedAt: new Date() },
        });
        console.log(`[Scheduler] Agent ${server.name} marked as ${newStatus}`);
      }
    }

    // Check for agents that never connected (waiting/deploying/stale with no push)
    // These should be marked offline if they've been waiting too long
    const waitingServers = await prisma.server.findMany({
      where: {
        metricsMode: 'agent',
        lastAgentPushAt: null, // Never received a push
        agentStatus: { in: ['waiting', 'deploying', 'stale'] },
        agentStatusChangedAt: { not: null }, // Has a status change time to check against
      },
      select: {
        id: true,
        name: true,
        agentStatus: true,
        agentStatusChangedAt: true,
        environmentId: true,
      },
    });

    for (const server of waitingServers) {
      if (!server.agentStatusChangedAt) continue;

      const statusChangedAt = new Date(server.agentStatusChangedAt);

      if (statusChangedAt < offlineThreshold) {
        // Agent has been waiting/deploying for too long without connecting - mark offline
        await prisma.server.update({
          where: { id: server.id },
          data: { agentStatus: 'offline', agentStatusChangedAt: new Date() },
        });
        console.log(`[Scheduler] Agent ${server.name} marked as offline (never connected)`);

        // Log status_change event
        await logAgentEvent({
          serverId: server.id,
          eventType: 'status_change',
          status: 'offline',
          message: 'Agent never connected after deployment',
          details: { previousStatus: server.agentStatus },
        });

        // Send notification
        const bounce = await recordFailure('server', server.id, 'offline', NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE);
        if (bounce.shouldAlert) {
          notifyAsync(
            NOTIFICATION_TYPES.SYSTEM_SERVER_OFFLINE,
            server.environmentId,
            { serverName: server.name, reason: 'Agent never connected after deployment' }
          );
        }
      } else if (statusChangedAt < staleThreshold && server.agentStatus === 'waiting') {
        // Agent has been waiting for a while - mark as stale
        await prisma.server.update({
          where: { id: server.id },
          data: { agentStatus: 'stale', agentStatusChangedAt: new Date() },
        });
        console.log(`[Scheduler] Agent ${server.name} marked as stale (not connecting)`);

        // Log status_change event
        await logAgentEvent({
          serverId: server.id,
          eventType: 'status_change',
          status: 'stale',
          message: 'Agent not connecting after deployment',
          details: { previousStatus: server.agentStatus },
        });
      }
    }
  } catch (error) {
    captureException(error, { scheduler: 'agentStalenessCheck' });
    console.error('[Scheduler] Agent staleness check failed:', error);
  }
}

/**
 * Clean up old metrics data (server, service, and data store metrics)
 */
async function runMetricsCleanup(retentionDays: number): Promise<void> {
  try {
    const deleted = await cleanupOldMetrics(retentionDays);
    if (deleted > 0) {
      console.log(`[Scheduler] Cleaned up ${deleted} old server/service metrics records`);
    }

    // Clean up database monitoring metrics
    const dbMetricsDeleted = await cleanupOldDatabaseMetrics(retentionDays);
    if (dbMetricsDeleted > 0) {
      console.log(`[Scheduler] Cleaned up ${dbMetricsDeleted} old database monitoring metrics records`);
    }
  } catch (error) {
    captureException(error, { scheduler: 'metricsCleanup' });
    console.error('[Scheduler] Metrics cleanup failed:', error);
  }
}

/**
 * Clean up old notifications
 */
async function runNotificationCleanup(retentionDays: number): Promise<void> {
  try {
    const deleted = await cleanupOldNotifications(retentionDays);
    if (deleted > 0) {
      console.log(`[Scheduler] Cleaned up ${deleted} old notification records`);
    }
  } catch (error) {
    captureException(error, { scheduler: 'notificationCleanup' });
    console.error('[Scheduler] Notification cleanup failed:', error);
  }
}

/**
 * Clean up old health check logs
 */
async function runHealthLogCleanup(retentionDays: number): Promise<void> {
  try {
    const deleted = await cleanupHealthCheckLogs(retentionDays);
    if (deleted > 0) {
      console.log(`[Scheduler] Cleaned up ${deleted} old health check log records`);
    }
  } catch (error) {
    captureException(error, { scheduler: 'healthLogCleanup' });
    console.error('[Scheduler] Health log cleanup failed:', error);
  }
}

/**
 * Clean up old audit logs based on system settings retention
 */
async function runAuditLogCleanup(): Promise<void> {
  try {
    const settings = await getSystemSettings();
    const deleted = await cleanupOldAuditLogs(settings.auditLogRetentionDays);
    if (deleted > 0) {
      console.log(`[Scheduler] Cleaned up ${deleted} old audit log records`);
    }
  } catch (error) {
    captureException(error, { scheduler: 'auditLogCleanup' });
    console.error('[Scheduler] Audit log cleanup failed:', error);
  }
}

/**
 * Start the scheduler with periodic health checks and discovery
 */
export function startScheduler(config: Partial<GlobalSchedulerConfig> = {}): void {
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
  console.log(`  - Database metrics: ${cfg.databaseMetricsIntervalMs / 1000}s`);
  console.log(`  - Backup checks: ${cfg.backupCheckIntervalMs / 1000}s`);
  console.log(`  - Metrics retention: ${cfg.metricsRetentionDays} days`);
  console.log(`  - Health log retention: ${cfg.healthLogRetentionDays} days`);

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
  timers.set('databaseMetrics', setInterval(runDatabaseMetricsCollection, cfg.databaseMetricsIntervalMs));
  timers.set('backupCheck', setInterval(runBackupChecks, cfg.backupCheckIntervalMs));
  timers.set('agentStaleness', setInterval(runAgentStalenessCheck, 30000)); // Every 30 seconds
  timers.set('cleanup', setInterval(() => runMetricsCleanup(cfg.metricsRetentionDays), 60 * 60 * 1000));
  timers.set('notificationCleanup', setInterval(() => runNotificationCleanup(cfg.notificationRetentionDays), 24 * 60 * 60 * 1000)); // Daily
  timers.set('healthLogCleanup', setInterval(() => runHealthLogCleanup(cfg.healthLogRetentionDays), 24 * 60 * 60 * 1000)); // Daily
  timers.set('auditLogCleanup', setInterval(runAuditLogCleanup, 24 * 60 * 60 * 1000)); // Daily
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
