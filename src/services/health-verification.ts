import { prisma } from '../lib/db.js';
import { DockerSSH, createClientForServer } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { determineHealthStatus, determineOverallStatus, type UrlHealthResult } from './servers.js';

export interface HealthVerificationResult {
  healthy: boolean;
  containerStatus: string;
  healthStatus: string;
  urlCheck?: { success: boolean; statusCode?: number; error?: string };
  attempts: number;
  logs: string[];
}

export interface HealthVerificationOptions {
  serviceId: string;
  waitMs?: number;        // Initial wait before checking (default: service.healthWaitMs)
  maxRetries?: number;    // Number of attempts (default: service.healthRetries)
  intervalMs?: number;    // Time between retries (default: service.healthIntervalMs)
}

/**
 * Wait for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify service health with configurable timing.
 * Used during orchestrated deployments to gate deployment progression.
 */
export async function verifyServiceHealth(
  options: HealthVerificationOptions
): Promise<HealthVerificationResult> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: options.serviceId },
    include: {
      server: {
        include: { environment: true },
      },
    },
  });

  // Use provided options or fall back to service-specific config
  const waitMs = options.waitMs ?? service.healthWaitMs;
  const maxRetries = options.maxRetries ?? service.healthRetries;
  const intervalMs = options.intervalMs ?? service.healthIntervalMs;

  const logs: string[] = [];
  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${message}`);
  };

  log(`Starting health verification for ${service.name}`);
  log(`Config: waitMs=${waitMs}, maxRetries=${maxRetries}, intervalMs=${intervalMs}`);

  // Initial wait for service to stabilize
  if (waitMs > 0) {
    log(`Waiting ${waitMs}ms for service to stabilize...`);
    await sleep(waitMs);
  }

  // Create SSH client
  const { client, error: clientError } = await createClientForServer(
    service.server.hostname,
    service.server.environmentId,
    getEnvironmentSshKey
  );

  if (!client) {
    log(`ERROR: Failed to create client: ${clientError}`);
    return {
      healthy: false,
      containerStatus: 'unknown',
      healthStatus: 'unknown',
      attempts: 0,
      logs,
    };
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();
    log(`Connected to ${service.server.name}`);

    let attempt = 0;
    let lastContainerStatus = 'unknown';
    let lastHealthStatus = 'unknown';
    let lastUrlCheck: UrlHealthResult | undefined;

    while (attempt < maxRetries) {
      attempt++;
      log(`Health check attempt ${attempt}/${maxRetries}`);

      // Get container health
      const containerHealth = await docker.getContainerHealth(service.containerName);
      lastContainerStatus = containerHealth.state;

      // Check URL health if configured
      let urlHealth: UrlHealthResult | null = null;
      if (service.healthCheckUrl) {
        urlHealth = await docker.checkUrl(service.healthCheckUrl);
        lastUrlCheck = urlHealth;
        log(`URL check (${service.healthCheckUrl}): ${urlHealth.success ? 'success' : 'failed'} - ${urlHealth.statusCode || urlHealth.error}`);
      }

      // Determine health status
      lastHealthStatus = determineHealthStatus(
        containerHealth.health,
        containerHealth.running,
        urlHealth
      );

      const overallStatus = determineOverallStatus(
        containerHealth.state,
        containerHealth.running,
        lastHealthStatus
      );

      log(`Container: ${containerHealth.state}, Health: ${lastHealthStatus}, Overall: ${overallStatus}`);

      // Check if healthy
      if (lastHealthStatus === 'healthy') {
        log(`Service ${service.name} is healthy`);

        // Update service status in database
        await prisma.service.update({
          where: { id: service.id },
          data: {
            containerStatus: lastContainerStatus,
            healthStatus: lastHealthStatus,
            status: overallStatus,
            lastCheckedAt: new Date(),
          },
        });

        return {
          healthy: true,
          containerStatus: lastContainerStatus,
          healthStatus: lastHealthStatus,
          urlCheck: lastUrlCheck,
          attempts: attempt,
          logs,
        };
      }

      // Also accept 'running' or 'none' if there's no health check configured
      if (lastHealthStatus === 'none' && containerHealth.running) {
        log(`Service ${service.name} is running (no health check configured)`);

        await prisma.service.update({
          where: { id: service.id },
          data: {
            containerStatus: lastContainerStatus,
            healthStatus: lastHealthStatus,
            status: 'running',
            lastCheckedAt: new Date(),
          },
        });

        return {
          healthy: true,
          containerStatus: lastContainerStatus,
          healthStatus: lastHealthStatus,
          urlCheck: lastUrlCheck,
          attempts: attempt,
          logs,
        };
      }

      // Wait before next attempt (unless this is the last attempt)
      if (attempt < maxRetries) {
        log(`Waiting ${intervalMs}ms before next attempt...`);
        await sleep(intervalMs);
      }
    }

    // All retries exhausted
    log(`Health verification failed after ${maxRetries} attempts`);

    // Update service status
    await prisma.service.update({
      where: { id: service.id },
      data: {
        containerStatus: lastContainerStatus,
        healthStatus: lastHealthStatus,
        lastCheckedAt: new Date(),
      },
    });

    return {
      healthy: false,
      containerStatus: lastContainerStatus,
      healthStatus: lastHealthStatus,
      urlCheck: lastUrlCheck,
      attempts: attempt,
      logs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);

    return {
      healthy: false,
      containerStatus: 'unknown',
      healthStatus: 'unknown',
      attempts: 0,
      logs,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Quick health check without retries (for status updates)
 */
export async function quickHealthCheck(
  serviceId: string
): Promise<{ containerStatus: string; healthStatus: string; running: boolean }> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: {
      server: {
        include: { environment: true },
      },
    },
  });

  const { client, error: clientError } = await createClientForServer(
    service.server.hostname,
    service.server.environmentId,
    getEnvironmentSshKey
  );

  if (!client) {
    return { containerStatus: 'unknown', healthStatus: 'unknown', running: false };
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();
    const containerHealth = await docker.getContainerHealth(service.containerName);

    let urlHealth: UrlHealthResult | null = null;
    if (service.healthCheckUrl) {
      urlHealth = await docker.checkUrl(service.healthCheckUrl);
    }

    const healthStatus = determineHealthStatus(
      containerHealth.health,
      containerHealth.running,
      urlHealth
    );

    return {
      containerStatus: containerHealth.state,
      healthStatus,
      running: containerHealth.running,
    };
  } catch {
    return { containerStatus: 'unknown', healthStatus: 'unknown', running: false };
  } finally {
    client.disconnect();
  }
}
