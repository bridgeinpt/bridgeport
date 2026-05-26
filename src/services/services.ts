import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { HEALTH_STATUS, CONTAINER_STATUS } from '../lib/constants.js';

export interface ServiceHealthResult {
  status: string;
  container: {
    running: boolean;
    state: string;
    status: string;
    health?: string;
  };
  url: {
    success: boolean;
    statusCode?: number;
    error?: string;
  } | null;
  lastCheckedAt: string;
}

/**
 * Check health of a service deployment (container status + optional URL check).
 * Takes a serviceDeploymentId (per-server runtime). Container/URL status are
 * persisted on the ServiceDeployment row.
 */
export async function checkServiceHealth(serviceDeploymentId: string): Promise<ServiceHealthResult> {
  const deployment = await prisma.serviceDeployment.findUnique({
    where: { id: serviceDeploymentId },
    include: {
      server: true,
      service: { select: { healthCheckUrl: true } },
    },
  });

  if (!deployment) {
    throw new Error('Service deployment not found');
  }

  // Create appropriate client based on hostname
  let client;
  if (isLocalhost(deployment.server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(deployment.server.environmentId);
    if (!sshCreds) {
      throw new Error('SSH key not configured for this environment');
    }
    client = new SSHClient({
      hostname: deployment.server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();

    // Check container health
    const containerHealth = await docker.getContainerHealth(deployment.containerName);

    // Check URL health if configured (URL is on the template)
    let urlHealth: { success: boolean; statusCode?: number; error?: string } | null = null;
    if (deployment.service.healthCheckUrl) {
      urlHealth = await docker.checkUrl(deployment.service.healthCheckUrl);
    }

    // Determine overall status
    let status: string;
    if (!containerHealth.running) {
      status = containerHealth.state === CONTAINER_STATUS.NOT_FOUND ? CONTAINER_STATUS.NOT_FOUND : CONTAINER_STATUS.STOPPED;
    } else if (containerHealth.health === HEALTH_STATUS.UNHEALTHY) {
      status = HEALTH_STATUS.UNHEALTHY;
    } else if (urlHealth && !urlHealth.success) {
      status = HEALTH_STATUS.UNHEALTHY;
    } else if (containerHealth.health === HEALTH_STATUS.HEALTHY || (urlHealth && urlHealth.success)) {
      status = HEALTH_STATUS.HEALTHY;
    } else {
      status = CONTAINER_STATUS.RUNNING;
    }

    // Update service deployment status in database
    await prisma.serviceDeployment.update({
      where: { id: serviceDeploymentId },
      data: {
        status,
        lastCheckedAt: new Date(),
      },
    });

    return {
      status,
      container: containerHealth,
      url: urlHealth,
      lastCheckedAt: new Date().toISOString(),
    };
  } finally {
    client.disconnect();
  }
}
