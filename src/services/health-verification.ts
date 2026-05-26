import { prisma } from '../lib/db.js';
import { DockerSSH } from '../lib/ssh.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { determineHealthStatus, determineOverallStatus, type UrlHealthResult } from './servers.js';
import { HEALTH_STATUS, CONTAINER_STATUS } from '../lib/constants.js';

export interface HealthVerificationResult {
  healthy: boolean;
  containerStatus: string;
  healthStatus: string;
  urlCheck?: { success: boolean; statusCode?: number; error?: string };
  attempts: number;
  logs: string[];
}

export interface HealthVerificationOptions {
  /** Per-server deployment id (the runtime entity to verify). */
  serviceDeploymentId: string;
  waitMs?: number;
  maxRetries?: number;
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify service-deployment health with configurable timing.
 * Used during orchestrated deployments to gate progression.
 */
export async function verifyServiceHealth(
  options: HealthVerificationOptions
): Promise<HealthVerificationResult> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: options.serviceDeploymentId },
    include: {
      server: { include: { environment: true } },
      service: { select: { name: true, healthCheckUrl: true, healthWaitMs: true, healthRetries: true, healthIntervalMs: true } },
    },
  });

  const waitMs = options.waitMs ?? deployment.service.healthWaitMs;
  const maxRetries = options.maxRetries ?? deployment.service.healthRetries;
  const intervalMs = options.intervalMs ?? deployment.service.healthIntervalMs;

  const logs: string[] = [];
  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${message}`);
  };

  log(`Starting health verification for ${deployment.service.name} on ${deployment.server.name}`);
  log(`Config: waitMs=${waitMs}, maxRetries=${maxRetries}, intervalMs=${intervalMs}`);

  if (waitMs > 0) {
    log(`Waiting ${waitMs}ms for service to stabilize...`);
    await sleep(waitMs);
  }

  const { dockerClient, sshClient, error: clientError, needsConnect } = await createDockerClientForServer(
    {
      hostname: deployment.server.hostname,
      dockerMode: deployment.server.dockerMode,
      serverType: deployment.server.serverType,
      environmentId: deployment.server.environmentId,
    },
    getEnvironmentSshKey
  );

  if (!dockerClient) {
    log(`ERROR: Failed to create client: ${clientError}`);
    return {
      healthy: false,
      containerStatus: HEALTH_STATUS.UNKNOWN,
      healthStatus: HEALTH_STATUS.UNKNOWN,
      attempts: 0,
      logs,
    };
  }

  const dockerSSH = sshClient ? new DockerSSH(sshClient) : null;

  try {
    if (needsConnect && sshClient) {
      await sshClient.connect();
    }
    log(`Connected to ${deployment.server.name}`);

    let attempt = 0;
    let lastContainerStatus: string = HEALTH_STATUS.UNKNOWN;
    let lastHealthStatus: string = HEALTH_STATUS.UNKNOWN;
    let lastUrlCheck: UrlHealthResult | undefined;

    while (attempt < maxRetries) {
      attempt++;
      log(`Health check attempt ${attempt}/${maxRetries}`);

      const containerHealth = await dockerClient.getContainerHealth(deployment.containerName);
      lastContainerStatus = containerHealth.state;

      let urlHealth: UrlHealthResult | null = null;
      if (deployment.service.healthCheckUrl && dockerSSH) {
        urlHealth = await dockerSSH.checkUrl(deployment.service.healthCheckUrl);
        lastUrlCheck = urlHealth;
        log(`URL check (${deployment.service.healthCheckUrl}): ${urlHealth.success ? 'success' : 'failed'} - ${urlHealth.statusCode || urlHealth.error}`);
      }

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

      if (lastHealthStatus === HEALTH_STATUS.HEALTHY) {
        log(`Service ${deployment.service.name} is healthy on ${deployment.server.name}`);

        await prisma.serviceDeployment.update({
          where: { id: deployment.id },
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

      if (lastHealthStatus === HEALTH_STATUS.NONE && containerHealth.running) {
        log(`Service ${deployment.service.name} is running (no health check configured)`);

        await prisma.serviceDeployment.update({
          where: { id: deployment.id },
          data: {
            containerStatus: lastContainerStatus,
            healthStatus: lastHealthStatus,
            status: CONTAINER_STATUS.RUNNING,
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

      if (attempt < maxRetries) {
        log(`Waiting ${intervalMs}ms before next attempt...`);
        await sleep(intervalMs);
      }
    }

    log(`Health verification failed after ${maxRetries} attempts`);

    await prisma.serviceDeployment.update({
      where: { id: deployment.id },
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
      containerStatus: HEALTH_STATUS.UNKNOWN,
      healthStatus: HEALTH_STATUS.UNKNOWN,
      attempts: 0,
      logs,
    };
  } finally {
    if (sshClient) {
      sshClient.disconnect();
    }
  }
}

/**
 * Quick health check without retries (for status updates).
 */
export async function quickHealthCheck(
  serviceDeploymentId: string
): Promise<{ containerStatus: string; healthStatus: string; running: boolean }> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: {
      server: { include: { environment: true } },
      service: { select: { healthCheckUrl: true } },
    },
  });

  const { dockerClient, sshClient, needsConnect } = await createDockerClientForServer(
    {
      hostname: deployment.server.hostname,
      dockerMode: deployment.server.dockerMode,
      serverType: deployment.server.serverType,
      environmentId: deployment.server.environmentId,
    },
    getEnvironmentSshKey
  );

  if (!dockerClient) {
    return { containerStatus: HEALTH_STATUS.UNKNOWN, healthStatus: HEALTH_STATUS.UNKNOWN, running: false };
  }

  const dockerSSH = sshClient ? new DockerSSH(sshClient) : null;

  try {
    if (needsConnect && sshClient) {
      await sshClient.connect();
    }
    const containerHealth = await dockerClient.getContainerHealth(deployment.containerName);

    let urlHealth: UrlHealthResult | null = null;
    if (deployment.service.healthCheckUrl && dockerSSH) {
      urlHealth = await dockerSSH.checkUrl(deployment.service.healthCheckUrl);
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
    return { containerStatus: HEALTH_STATUS.UNKNOWN, healthStatus: HEALTH_STATUS.UNKNOWN, running: false };
  } finally {
    if (sshClient) {
      sshClient.disconnect();
    }
  }
}
