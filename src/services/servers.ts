import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost, createClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import type { Server, Service } from '@prisma/client';

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
    include: { services: true },
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

export async function discoverContainers(serverId: string): Promise<DiscoverResult> {
  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    include: { environment: true, services: true },
  });

  // Create appropriate client based on hostname
  let client;
  if (isLocalhost(server.hostname)) {
    client = new LocalClient();
  } else {
    // Get SSH credentials from environment for remote servers
    const sshCreds = await getEnvironmentSshKey(server.environmentId);
    if (!sshCreds) {
      throw new Error('SSH key not configured for this environment');
    }
    client = new SSHClient({
      hostname: server.hostname,
      username: sshCreds.username,
      privateKey: sshCreds.privateKey,
    });
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();
    const containers = await docker.listContainers();

    const services: Service[] = [];
    const foundContainerNames = new Set<string>();

    for (const container of containers) {
      foundContainerNames.add(container.name);

      // Check if service already exists
      const existing = await prisma.service.findUnique({
        where: {
          serverId_name: {
            serverId,
            name: container.name,
          },
        },
      });

      if (existing) {
        // Update status and mark as found
        const updated = await prisma.service.update({
          where: { id: existing.id },
          data: {
            status: container.state,
            discoveryStatus: 'found',
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
          },
        });
        services.push(updated);
      } else {
        // Parse image name and tag
        const [imageName, imageTag = 'latest'] = container.image.split(':');

        const created = await prisma.service.create({
          data: {
            name: container.name,
            containerName: container.name,
            imageName,
            imageTag,
            status: container.state,
            discoveryStatus: 'found',
            lastCheckedAt: new Date(),
            lastDiscoveredAt: new Date(),
            serverId,
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
            lastCheckedAt: new Date(),
          },
        });
        missing.push(existingService.name);
      }
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
              imageName: serviceData.image_name,
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
              imageName: serviceData.image_name,
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
