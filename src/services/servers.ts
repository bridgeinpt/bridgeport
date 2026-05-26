import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, isLocalhost } from '../lib/ssh.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { parseRegistryFromImage } from '../lib/image-utils.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { findOrCreateContainerImage } from './image-management.js';
import { getErrorMessage } from '../lib/helpers.js';
import { SERVER_STATUS, HEALTH_STATUS, CONTAINER_STATUS, DISCOVERY_STATUS } from '../lib/constants.js';
import type { Server, Service, ServiceDeployment, RegistryConnection } from '@prisma/client';

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
  dockerMode?: 'socket' | 'ssh';
}

export interface ServerWithServices extends Server {
  serviceDeployments: (ServiceDeployment & { service: Service })[];
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
  if (input.dockerMode) updateData.dockerMode = input.dockerMode;

  return prisma.server.update({
    where: { id: serverId },
    data: updateData,
  });
}

export async function getServer(serverId: string): Promise<ServerWithServices | null> {
  return prisma.server.findUnique({
    where: { id: serverId },
    include: {
      serviceDeployments: {
        include: {
          service: { include: { containerImage: true } },
        },
      },
    },
  });
}

export async function listServers(
  environmentId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ servers: Server[]; total: number }> {
  const limit = options?.limit ?? 25;
  const offset = options?.offset ?? 0;
  const where = { environmentId };

  const [servers, total] = await Promise.all([
    prisma.server.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    }),
    prisma.server.count({ where }),
  ]);

  return { servers, total };
}

export async function deleteServer(serverId: string): Promise<void> {
  await prisma.server.delete({
    where: { id: serverId },
  });
}

export async function checkServerHealth(serverId: string): Promise<{
  status: typeof SERVER_STATUS.HEALTHY | typeof SERVER_STATUS.UNHEALTHY;
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
      const status = result.code === 0 ? SERVER_STATUS.HEALTHY : SERVER_STATUS.UNHEALTHY;

      await prisma.server.update({
        where: { id: serverId },
        data: { status, lastCheckedAt: new Date() },
      });

      if (status === SERVER_STATUS.UNHEALTHY) {
        const errorMsg = result.stderr?.trim() || `Command exited with code ${result.code}`;
        return { status, error: errorMsg };
      }
      return { status };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error) || 'Unknown error';
      await prisma.server.update({
        where: { id: serverId },
        data: { status: SERVER_STATUS.UNHEALTHY, lastCheckedAt: new Date() },
      });
      return { status: SERVER_STATUS.UNHEALTHY, error: errorMessage };
    }
  }

  // Get SSH credentials from environment for remote servers
  const sshCreds = await getEnvironmentSshKey(server.environmentId);
  if (!sshCreds) {
    return { status: SERVER_STATUS.UNHEALTHY, error: 'SSH key not configured for this environment' };
  }

  const ssh = new SSHClient({
    hostname: server.hostname,
    username: sshCreds.username,
    privateKey: sshCreds.privateKey,
  });

  try {
    await ssh.connect();
    const result = await ssh.exec('echo "ok"');

    const status = result.code === 0 ? SERVER_STATUS.HEALTHY : SERVER_STATUS.UNHEALTHY;

    await prisma.server.update({
      where: { id: serverId },
      data: {
        status,
        lastCheckedAt: new Date(),
      },
    });

    if (status === SERVER_STATUS.UNHEALTHY) {
      const errorMsg = result.stderr?.trim() || `Command exited with code ${result.code}`;
      return { status, error: errorMsg };
    }
    return { status };
  } catch (error) {
    // Extract error message - handle various error types from ssh2
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message || error.toString();
      // ssh2 errors may have additional info in 'level' property
      const sshError = error as Error & { level?: string };
      if (sshError.level) {
        errorMessage = `${sshError.level}: ${errorMessage}`;
      }
    } else if (error) {
      errorMessage = String(error);
    }

    await prisma.server.update({
      where: { id: serverId },
      data: {
        status: SERVER_STATUS.UNHEALTHY,
        lastCheckedAt: new Date(),
      },
    });

    return { status: SERVER_STATUS.UNHEALTHY, error: errorMessage };
  } finally {
    ssh.disconnect();
  }
}

export interface DiscoverResult {
  serviceDeployments: ServiceDeployment[];
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
    return HEALTH_STATUS.UNKNOWN;
  }
  if (containerHealth === HEALTH_STATUS.HEALTHY) {
    return HEALTH_STATUS.HEALTHY;
  }
  if (containerHealth === HEALTH_STATUS.UNHEALTHY) {
    return HEALTH_STATUS.UNHEALTHY;
  }
  // No Docker HEALTHCHECK, but we have URL check
  if (urlHealth) {
    return urlHealth.success ? HEALTH_STATUS.HEALTHY : HEALTH_STATUS.UNHEALTHY;
  }
  // Container has no HEALTHCHECK configured and no URL check
  if (!containerHealth) {
    return HEALTH_STATUS.NONE;
  }
  return HEALTH_STATUS.UNKNOWN;
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
    return containerState === CONTAINER_STATUS.NOT_FOUND ? CONTAINER_STATUS.NOT_FOUND : CONTAINER_STATUS.STOPPED;
  }
  if (healthStatus === HEALTH_STATUS.UNHEALTHY) {
    return HEALTH_STATUS.UNHEALTHY;
  }
  if (healthStatus === HEALTH_STATUS.HEALTHY) {
    return HEALTH_STATUS.HEALTHY;
  }
  return CONTAINER_STATUS.RUNNING;
}

export async function discoverContainers(serverId: string): Promise<DiscoverResult> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: {
      environment: true,
      serviceDeployments: { include: { service: { select: { name: true, environmentId: true } } } },
    },
  });

  // Get existing registries for this environment
  const registries = await prisma.registryConnection.findMany({
    where: { environmentId: server.environmentId },
  });

  // Create appropriate Docker client based on server's dockerMode
  const { dockerClient, sshClient, error: clientError, needsConnect, mode } = await createDockerClientForServer(
    {
      hostname: server.hostname,
      dockerMode: server.dockerMode,
      serverType: server.serverType,
      environmentId: server.environmentId,
    },
    getEnvironmentSshKey
  );

  console.log(`[Discover] Docker client mode: ${mode}, needsConnect: ${needsConnect}, hasClient: ${!!dockerClient}`);

  if (!dockerClient) {
    throw new Error(clientError || 'Failed to create Docker client');
  }

  try {
    if (needsConnect && sshClient) {
      console.log(`[Discover] Connecting SSH client...`);
      await sshClient.connect();
    }
    console.log(`[Discover] Listing containers...`);
    const containers = await dockerClient.listContainers();
    console.log(`[Discover] Found ${containers.length} containers`);

    const discoveredDeployments: ServiceDeployment[] = [];
    const foundContainerNames = new Set<string>();

    for (const container of containers) {
      foundContainerNames.add(container.name);

      // Get comprehensive container info including ports
      const containerInfo = await dockerClient.getContainerInfo(container.name);

      // Parse full image path and extract just the name
      const fullImagePath = containerInfo.image || container.image;
      const [fullImageName, imageTag = 'latest'] = fullImagePath.split(':');

      // Determine container and health status
      const containerStatus = containerInfo.state || container.state;
      const healthStatus = determineHealthStatus(containerInfo.health, containerInfo.running);

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

      // Check if a ServiceDeployment already exists for this (server, containerName).
      const existingDeployment = await prisma.serviceDeployment.findUnique({
        where: {
          serverId_containerName: {
            serverId,
            containerName: container.name,
          },
        },
      });

      if (existingDeployment) {
        // Keep tag in sync at the template level (imageTag lives on Service in 2.0).
        await prisma.service.update({
          where: { id: existingDeployment.serviceId },
          data: { imageTag, containerImageId: containerImage.id },
        });

        const updated = await prisma.serviceDeployment.update({
          where: { id: existingDeployment.id },
          data: {
            status: containerStatus,
            containerStatus,
            healthStatus,
            exposedPorts,
            discoveryStatus: DISCOVERY_STATUS.FOUND,
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
          },
        });
        discoveredDeployments.push(updated);
      } else {
        // Locate or create a Service template. Reuse an existing template only
        // when (environmentId, name, containerImageId) all match — otherwise
        // attaching a new deployment to a template that points at a DIFFERENT
        // image would cause deployServiceTemplate(template) to push the wrong
        // image to this server. When the image differs, mint a fresh template
        // with a suffixed name.
        const existingTemplate = await prisma.service.findUnique({
          where: { environmentId_name: { environmentId: server.environmentId, name: container.name } },
        });

        let service;
        if (existingTemplate && existingTemplate.containerImageId === containerImage.id) {
          service = existingTemplate;
        } else if (existingTemplate) {
          // Same name but a different image is in use on another server. Pick
          // a unique name so we don't accidentally collapse two distinct services
          // (and clobber the other server's image on the next template deploy).
          let suffix = 2;
          let candidate = `${container.name}-${server.name}`;
          // Probe for a free name; if a row with that name exists with a
          // DIFFERENT image, walk a numeric suffix.
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const probe = await prisma.service.findUnique({
              where: { environmentId_name: { environmentId: server.environmentId, name: candidate } },
            });
            if (!probe) break;
            if (probe.containerImageId === containerImage.id) {
              service = probe;
              break;
            }
            candidate = `${container.name}-${server.name}-${suffix++}`;
          }
          service =
            service ??
            (await prisma.service.create({
              data: {
                name: candidate,
                imageTag,
                environmentId: server.environmentId,
                containerImageId: containerImage.id,
              },
            }));
        } else {
          service = await prisma.service.create({
            data: {
              name: container.name,
              imageTag,
              environmentId: server.environmentId,
              containerImageId: containerImage.id,
            },
          });
        }

        const created = await prisma.serviceDeployment.create({
          data: {
            serviceId: service.id,
            serverId,
            containerName: container.name,
            status: containerStatus,
            containerStatus,
            healthStatus,
            exposedPorts,
            discoveryStatus: DISCOVERY_STATUS.FOUND,
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
          },
        });
        discoveredDeployments.push(created);
      }
    }

    // Mark deployments as missing if not found (don't delete).
    const missing: string[] = [];
    for (const existing of server.serviceDeployments) {
      if (!foundContainerNames.has(existing.containerName)) {
        await prisma.serviceDeployment.update({
          where: { id: existing.id },
          data: {
            discoveryStatus: DISCOVERY_STATUS.MISSING,
            status: CONTAINER_STATUS.STOPPED,
            containerStatus: CONTAINER_STATUS.NOT_FOUND,
            healthStatus: HEALTH_STATUS.UNKNOWN,
            lastCheckedAt: new Date(),
          },
        });
        missing.push(existing.service.name);
      }
    }

    // Check for available image updates for discovered deployments.
    for (const sd of discoveredDeployments) {
      checkServiceUpdate(sd.id).catch(() => {
        console.error('[Discovery] Failed to check updates for deployment', sd.id);
      });
    }

    return { serviceDeployments: discoveredDeployments, missing };
  } finally {
    if (sshClient) {
      sshClient.disconnect();
    }
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
              tagFilter: serviceData.image_tag ?? 'latest',
              environmentId,
            },
          });
        }

        // Find or create the Service template by (environmentId, name).
        const existingService = await prisma.service.findUnique({
          where: { environmentId_name: { environmentId, name: serviceData.name } },
        });

        const service = existingService
          ? await prisma.service.update({
              where: { id: existingService.id },
              data: {
                containerImageId: containerImage.id,
                imageTag: serviceData.image_tag ?? 'latest',
                healthCheckUrl: serviceData.health_check_url,
              },
            })
          : await prisma.service.create({
              data: {
                name: serviceData.name,
                environmentId,
                containerImageId: containerImage.id,
                imageTag: serviceData.image_tag ?? 'latest',
                healthCheckUrl: serviceData.health_check_url,
              },
            });

        // Find or create the per-server ServiceDeployment for this template.
        const existingDeployment = await prisma.serviceDeployment.findUnique({
          where: { serviceId_serverId: { serviceId: service.id, serverId: server.id } },
        });

        if (existingDeployment) {
          await prisma.serviceDeployment.update({
            where: { id: existingDeployment.id },
            data: {
              containerName: serviceData.container_name,
              composePath: serviceData.compose_path,
            },
          });
        } else {
          await prisma.serviceDeployment.create({
            data: {
              serviceId: service.id,
              serverId: server.id,
              containerName: serviceData.container_name,
              composePath: serviceData.compose_path,
            },
          });
        }
      }
    }

    servers.push(server);
  }

  return servers;
}

/**
 * Prune unused Docker images on a server to reclaim disk space.
 * Handles both socket and SSH docker modes; manages the SSH connection lifecycle internally.
 */
export async function pruneServerImages(
  server: { id: string; name: string; hostname: string; dockerMode: string; serverType: string; environmentId: string },
  mode: 'dangling' | 'all' = 'dangling'
): Promise<{ spaceReclaimedBytes: number }> {
  const { dockerClient, sshClient, error, needsConnect } = await createDockerClientForServer(server, getEnvironmentSshKey);
  if (!dockerClient) throw new Error(error || 'Failed to create Docker client');
  try {
    if (needsConnect && sshClient) await sshClient.connect();
    return await dockerClient.pruneImages(mode);
  } finally {
    if (sshClient) sshClient.disconnect();
  }
}
