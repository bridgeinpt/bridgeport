import { prisma } from './db.js';
import { checkServerHealth, discoverContainers } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { RegistryFactory, type RegistryCredentials } from './registry.js';
import { getRegistryCredentials } from '../services/registries.js';
import { deployService } from '../services/deploy.js';

interface SchedulerConfig {
  serverHealthIntervalMs: number;
  serviceHealthIntervalMs: number;
  discoveryIntervalMs: number;
  updateCheckIntervalMs: number;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  serverHealthIntervalMs: 60 * 1000, // 1 minute
  serviceHealthIntervalMs: 60 * 1000, // 1 minute
  discoveryIntervalMs: 5 * 60 * 1000, // 5 minutes
  updateCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
};

let serverHealthTimer: NodeJS.Timeout | null = null;
let serviceHealthTimer: NodeJS.Timeout | null = null;
let discoveryTimer: NodeJS.Timeout | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Run health checks on all servers
 */
async function runServerHealthChecks(): Promise<void> {
  try {
    const servers = await prisma.server.findMany({
      select: { id: true, name: true },
    });

    console.log(`[Scheduler] Running health checks on ${servers.length} servers`);

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
 */
async function runServiceHealthChecks(): Promise<void> {
  try {
    const services = await prisma.service.findMany({
      where: {
        healthCheckUrl: { not: null },
        discoveryStatus: 'found',
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
 * Extract repository name from full image name
 * e.g., "registry.digitalocean.com/bios-registry/app-api" -> "app-api"
 */
function extractRepoName(imageName: string, repositoryPrefix: string | null): string {
  // Remove registry domain and any prefix
  const parts = imageName.split('/');
  let repo = parts[parts.length - 1];

  // If there's a prefix pattern like "prefix/repo", handle it
  if (repositoryPrefix && parts.length > 1) {
    const prefixIdx = parts.findIndex((p) => p === repositoryPrefix);
    if (prefixIdx >= 0 && prefixIdx < parts.length - 1) {
      repo = parts.slice(prefixIdx + 1).join('/');
    }
  }

  return repo;
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

  // Run initial checks after a short delay
  setTimeout(() => {
    runServerHealthChecks();
  }, 5000);

  // Set up periodic timers
  serverHealthTimer = setInterval(runServerHealthChecks, cfg.serverHealthIntervalMs);
  serviceHealthTimer = setInterval(runServiceHealthChecks, cfg.serviceHealthIntervalMs);
  discoveryTimer = setInterval(runDiscovery, cfg.discoveryIntervalMs);
  updateCheckTimer = setInterval(runUpdateChecks, cfg.updateCheckIntervalMs);
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (!isRunning) {
    return;
  }

  console.log('[Scheduler] Stopping');

  if (serverHealthTimer) {
    clearInterval(serverHealthTimer);
    serverHealthTimer = null;
  }

  if (serviceHealthTimer) {
    clearInterval(serviceHealthTimer);
    serviceHealthTimer = null;
  }

  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }

  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  isRunning = false;
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return isRunning;
}
