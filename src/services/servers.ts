import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost, createClientForServer } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { parseRegistryFromImage } from '../lib/image-utils.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { findOrCreateContainerImage } from './image-management.js';
import type { Server, Service, RegistryConnection } from '@prisma/client';

/**
 * Find a matching registry for an image or create a new one
 */
async function findOrCreateRegistry(
  environmentId: string,
  imageName: string,
  registries: RegistryConnection[]
): Promise<string | null> {
  const { registryUrl, isDockerHub } = parseRegistryFromImage(imageName);

  // Try to find a matching registry
  for (const registry of registries) {
    // Check if registry URL matches
    if (registry.registryUrl.includes(registryUrl) || registryUrl.includes(registry.registryUrl)) {
      return registry.id;
    }
    // Check autoLinkPattern if set
    if (registry.autoLinkPattern && new RegExp(registry.autoLinkPattern).test(imageName)) {
      return registry.id;
    }
  }

  // Don't auto-create registries for Docker Hub (too common, usually doesn't need auth)
  if (isDockerHub) {
    return null;
  }

  // Create a new registry for this image
  const registryName = registryUrl.replace(/\./g, '-');
  const type = registryUrl.includes('digitalocean') ? 'digitalocean' : 'generic';

  const newRegistry = await prisma.registryConnection.create({
    data: {
      name: registryName,
      type,
      registryUrl: `https://${registryUrl}`,
      environmentId,
    },
  });

  return newRegistry.id;
}

export interface ServerInput {
  name: string;
  hostname: string;
  publicIp?: string | null;
  tags?: string[];
}

export interface ServerWithServices extends Server {
  services: Service[];
}

export async function createServer(
  environmentId: string,
  input: ServerInput
): Promise<Server> {
  return prisma.server.create({
    data: {
      name: input.name,
      hostname: input.hostname,
      publicIp: input.publicIp,
      tags: JSON.stringify(input.tags || []),
      environmentId,
    },
  });
}

export async function updateServer(
  serverId: string,
  input: Partial<ServerInput>
): Promise<Server> {
  const updateData: Partial<Server> = {};

  if (input.name) updateData.name = input.name;
  if (input.hostname) updateData.hostname = input.hostname;
  if (input.publicIp !== undefined) updateData.publicIp = input.publicIp || null;
  if (input.tags) updateData.tags = JSON.stringify(input.tags);

  return prisma.server.update({
    where: { id: serverId },
    data: updateData,
  });
}

export async function getServer(serverId: string): Promise<ServerWithServices | null> {
  return prisma.server.findUnique({
    where: { id: serverId },
    include: {
      services: {
        include: {
          containerImage: true,
        },
      },
    },
  });
}

export async function listServers(environmentId: string): Promise<Server[]> {
  return prisma.server.findMany({
    where: { environmentId },
    orderBy: { name: 'asc' },
  });
}

export async function deleteServer(serverId: string): Promise<void> {
  await prisma.server.delete({
    where: { id: serverId },
  });
}

export async function checkServerHealth(serverId: string): Promise<{
  status: 'healthy' | 'unhealthy';
  error?: string;
}> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    include: { environment: true },
  });

  if (!server) {
    throw new Error('Server not found');
  }

  // For localhost, use local execution
  if (isLocalhost(server.hostname)) {
    const client = new LocalClient();
    try {
      await client.connect();
      const result = await client.exec('echo "ok"');
      const status = result.code === 0 ? 'healthy' : 'unhealthy';

      await prisma.server.update({
        where: { id: serverId },
        data: { status, lastCheckedAt: new Date() },
      });

      return { status };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await prisma.server.update({
        where: { id: serverId },
        data: { status: 'unhealthy', lastCheckedAt: new Date() },
      });
      return { status: 'unhealthy', error: errorMessage };
    }
  }

  // Get SSH credentials from environment for remote servers
  const sshCreds = await getEnvironmentSshKey(server.environmentId);
  if (!sshCreds) {
    return { status: 'unhealthy', error: 'SSH key not configured for this environment' };
  }

  const ssh = new SSHClient({
    hostname: server.hostname,
    username: sshCreds.username,
    privateKey: sshCreds.privateKey,
  });

  try {
    await ssh.connect();
    const result = await ssh.exec('echo "ok"');

    const status = result.code === 0 ? 'healthy' : 'unhealthy';

    await prisma.server.update({
      where: { id: serverId },
      data: {
        status,
        lastCheckedAt: new Date(),
      },
    });

    return { status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await prisma.server.update({
      where: { id: serverId },
      data: {
        status: 'unhealthy',
        lastCheckedAt: new Date(),
      },
    });

    return { status: 'unhealthy', error: errorMessage };
  } finally {
    ssh.disconnect();
  }
}

export interface DiscoverResult {
  services: Service[];
  missing: string[];
}

export interface UrlHealthResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Determine health status from container health and optional URL check result
 */
export function determineHealthStatus(
  containerHealth: string | undefined,
  running: boolean,
  urlHealth?: UrlHealthResult | null
): string {
  if (!running) {
    return 'unknown';
  }
  if (containerHealth === 'healthy') {
    return 'healthy';
  }
  if (containerHealth === 'unhealthy') {
    return 'unhealthy';
  }
  // No Docker HEALTHCHECK, but we have URL check
  if (urlHealth) {
    return urlHealth.success ? 'healthy' : 'unhealthy';
  }
  // Container has no HEALTHCHECK configured and no URL check
  if (!containerHealth) {
    return 'none';
  }
  return 'unknown';
}

/**
 * Determine overall service status from container state and health status
 */
export function determineOverallStatus(
  containerState: string,
  running: boolean,
  healthStatus: string
): string {
  if (!running) {
    return containerState === 'not_found' ? 'not_found' : 'stopped';
  }
  if (healthStatus === 'unhealthy') {
    return 'unhealthy';
  }
  if (healthStatus === 'healthy') {
    return 'healthy';
  }
  return 'running';
}

export async function discoverContainers(serverId: string): Promise<DiscoverResult> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { environment: true, services: true },
  });

  // Get existing registries for this environment
  const registries = await prisma.registryConnection.findMany({
    where: { environmentId: server.environmentId },
  });

  // Create appropriate client based on hostname
  const { client, error: clientError } = await createClientForServer(
    server.hostname,
    server.environmentId,
    getEnvironmentSshKey
  );
  if (!client) {
    throw new Error(clientError || 'Failed to create SSH client');
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();
    const containers = await docker.listContainers();

    const services: Service[] = [];
    const foundContainerNames = new Set<string>();

    for (const container of containers) {
      foundContainerNames.add(container.name);

      // Get comprehensive container info including ports
      const containerInfo = await docker.getContainerInfo(container.name);

      // Check if service already exists
      const existing = await prisma.service.findUnique({
        where: {
          serverId_name: {
            serverId,
            name: container.name,
          },
        },
      });

      // Parse full image path and extract just the name
      const fullImagePath = containerInfo.image || container.image;
      const [fullImageName, imageTag = 'latest'] = fullImagePath.split(':');

      // Determine container and health status
      const containerStatus = containerInfo.state || container.state;
      const healthStatus = determineHealthStatus(containerInfo.health, containerInfo.running);

      // Serialize ports to JSON
      const exposedPorts = containerInfo.ports.length > 0
        ? JSON.stringify(containerInfo.ports)
        : null;

      // Find or create matching registry (re-fetch registries to include any newly created)
      const currentRegistries = await prisma.registryConnection.findMany({
        where: { environmentId: server.environmentId },
      });
      const registryConnectionId = await findOrCreateRegistry(
        server.environmentId,
        fullImageName,
        currentRegistries
      );

      // Find or create ContainerImage for this image
      const containerImage = await findOrCreateContainerImage(
        server.environmentId,
        fullImageName,
        imageTag,
        registryConnectionId
      );

      if (existing) {
        // Update status, ports, mark as found
        const updated = await prisma.service.update({
          where: { id: existing.id },
          data: {
            status: containerStatus, // Keep for backwards compatibility
            containerStatus,
            healthStatus,
            exposedPorts,
            imageTag, // Update to current running tag
            discoveryStatus: 'found',
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
            // Update containerImageId if changed or not set
            containerImageId: containerImage.id,
          },
        });
        services.push(updated);
      } else {
        const created = await prisma.service.create({
          data: {
            name: container.name,
            containerName: container.name,
            imageTag,
            status: containerStatus, // Keep for backwards compatibility
            containerStatus,
            healthStatus,
            exposedPorts,
            discoveryStatus: 'found',
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
            serverId,
            containerImageId: containerImage.id,
          },
        });
        services.push(created);
      }
    }

    // Mark services as missing if they weren't found (instead of deleting)
    const missing: string[] = [];
    for (const existingService of server.services) {
      if (!foundContainerNames.has(existingService.name)) {
        await prisma.service.update({
          where: { id: existingService.id },
          data: {
            discoveryStatus: 'missing',
            status: 'stopped',
            containerStatus: 'not_found',
            healthStatus: 'unknown',
            lastCheckedAt: new Date(),
          },
        });
        missing.push(existingService.name);
      }
    }

    // Check for available image updates for discovered services
    // The containerImage now has the registry connection
    for (const service of services) {
      // Run in background, don't block discovery
      checkServiceUpdate(service.id).catch((err) => {
        console.error(`[Discovery] Failed to check updates for ${service.name}:`, err);
      });
    }

    return { services, missing };
  } finally {
    client.disconnect();
  }
}

export interface TerraformOutput {
  servers: Array<{
    name: string;
    private_ip: string;
    public_ip?: string | null;
    tags: string[];
    services?: Array<{
      name: string;
      container_name: string;
      image_name: string;
      image_tag?: string;
      compose_path?: string | null;
      health_check_url?: string | null;
    }>;
  }>;
}

export async function importFromTerraform(
  environmentId: string,
  tfOutput: TerraformOutput
): Promise<Server[]> {
  const servers: Server[] = [];

  for (const serverData of tfOutput.servers) {
    let server: Server;

    const existing = await prisma.server.findUnique({
      where: {
        environmentId_name: {
          environmentId,
          name: serverData.name,
        },
      },
    });

    if (existing) {
      server = await prisma.server.update({
        where: { id: existing.id },
        data: {
          hostname: serverData.private_ip,
          publicIp: serverData.public_ip ?? null,
          tags: JSON.stringify(serverData.tags),
        },
      });
    } else {
      server = await prisma.server.create({
        data: {
          name: serverData.name,
          hostname: serverData.private_ip,
          publicIp: serverData.public_ip ?? null,
          tags: JSON.stringify(serverData.tags),
          environmentId,
        },
      });
    }

    // Import services for this server
    if (serverData.services) {
      for (const serviceData of serverData.services) {
        // Find or create ContainerImage for this service's image
        let containerImage = await prisma.containerImage.findUnique({
          where: {
            environmentId_imageName: {
              environmentId,
              imageName: serviceData.image_name,
            },
          },
        });

        if (!containerImage) {
          // Extract display name from image name (last part after /)
          const parts = serviceData.image_name.split('/');
          const lastPart = parts[parts.length - 1];
          const [displayName] = lastPart.split(':');
          const name = displayName
            .split('-')
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

          containerImage = await prisma.containerImage.create({
            data: {
              name,
              imageName: serviceData.image_name,
              currentTag: serviceData.image_tag ?? 'latest',
              environmentId,
            },
          });
        }

        const existingService = await prisma.service.findFirst({
          where: {
            serverId: server.id,
            name: serviceData.name,
          },
        });

        if (existingService) {
          await prisma.service.update({
            where: { id: existingService.id },
            data: {
              containerName: serviceData.container_name,
              containerImageId: containerImage.id,
              imageTag: serviceData.image_tag ?? 'latest',
              composePath: serviceData.compose_path,
              healthCheckUrl: serviceData.health_check_url,
            },
          });
        } else {
          await prisma.service.create({
            data: {
              name: serviceData.name,
              containerName: serviceData.container_name,
              containerImageId: containerImage.id,
              imageTag: serviceData.image_tag ?? 'latest',
              composePath: serviceData.compose_path,
              healthCheckUrl: serviceData.health_check_url,
              serverId: server.id,
            },
          });
        }
      }
    }

    servers.push(server);
  }

  return servers;
}
