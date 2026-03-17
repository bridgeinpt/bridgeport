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
 * Check health of a service (container status + optional URL check)
 */
export async function checkServiceHealth(serviceId: string): Promise<ServiceHealthResult> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { server: true },
  });

  if (!service) {
    throw new Error('Service not found');
  }

  // Create appropriate client based on hostname
  let client;
  if (isLocalhost(service.server.hostname)) {
    client = new LocalClient();
  } else {
    const sshCreds = await getEnvironmentSshKey(service.server.environmentId);
    if (!sshCreds) {
      throw new Error('SSH key not configured for this environment');
    }
    client = new SSHClient({
      hostname: service.server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();

    // Check container health
    const containerHealth = await docker.getContainerHealth(service.containerName);

    // Check URL health if configured
    let urlHealth: { success: boolean; statusCode?: number; error?: string } | null = null;
    if (service.healthCheckUrl) {
      urlHealth = await docker.checkUrl(service.healthCheckUrl);
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

    // Update service status in database
    await prisma.service.update({
      where: { id: serviceId },
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
