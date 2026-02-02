import path from 'path';
import { prisma } from '../lib/db.js';
import { DockerSSH, createClientForServer, type CommandClient } from '../lib/ssh.js';
import { registryClient } from '../lib/registry.js';
import { generateDeploymentArtifacts, saveDeploymentArtifacts } from './compose.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import type { Deployment, Service } from '@prisma/client';

export interface DeployOptions {
  imageTag?: string;
  generateArtifacts?: boolean;  // Generate compose, env, config files
  pullImage?: boolean;
}

export interface DeployResult {
  deployment: Deployment;
  logs: string;
}

export async function deployService(
  serviceId: string,
  triggeredBy: string,
  userId: string | null,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: {
      server: {
        include: { environment: true },
      },
    },
  });

  const imageTag = options.imageTag || service.imageTag;
  const logs: string[] = [];

  // Create deployment record
  const deployment = await prisma.deployment.create({
    data: {
      imageTag,
      status: 'pending',
      triggeredBy,
      serviceId,
      userId,
    },
  });

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${message}`);
  };

  try {
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: 'deploying' },
    });

    log(`Starting deployment of ${service.name} with tag ${imageTag}`);

    // Create appropriate client based on hostname
    const { client, error: clientError } = await createClientForServer(
      service.server.hostname,
      service.server.environmentId,
      getEnvironmentSshKey
    );
    if (!client) {
      throw new Error(clientError || 'Failed to create SSH client');
    }

    const docker = new DockerSSH(client);

    await client.connect();
    log(`Connected to ${service.server.name} (${service.server.hostname})`);

    // Determine deploy directory (use path.dirname to properly handle any path)
    const deployDir = service.composePath
      ? path.dirname(service.composePath)
      : `/opt/${service.name}`;

    await client.exec(`mkdir -p ${deployDir}`);

    // Generate deployment artifacts (compose, env, config files)
    if (options.generateArtifacts !== false) {
      log('Generating deployment artifacts...');

      // Temporarily update the image tag for artifact generation
      await prisma.service.update({
        where: { id: serviceId },
        data: { imageTag },
      });

      const artifacts = await generateDeploymentArtifacts(serviceId);

      // Upload compose file (preserve existing path if set, otherwise use generated name)
      const composePath = service.composePath || `${deployDir}/${artifacts.compose.name}`;
      log(`Writing compose file to ${composePath}`);
      await client.exec(`cat > ${composePath} << 'COMPOSEEOF'\n${artifacts.compose.content}\nCOMPOSEEOF`);

      // Upload config files to their configured target paths
      for (const cf of artifacts.configFiles) {
        // Use the configured mountPath (targetPath) for the file
        const cfPath = cf.mountPath;

        // Ensure target directory exists
        const cfDir = path.dirname(cfPath);
        await client.exec(`mkdir -p "${cfDir}"`);

        log(`Writing config file: ${cf.name} -> ${cfPath}`);

        if (cf.isBinary) {
          // Binary files: content is base64-encoded, decode on the server
          // Use heredoc to avoid shell argument length limits
          await client.exec(`base64 -d > "${cfPath}" << 'BASE64EOF'\n${cf.content}\nBASE64EOF`);
        } else {
          // Text files: use heredoc
          await client.exec(`cat > "${cfPath}" << 'CFEOF'\n${cf.content}\nCFEOF`);
        }

        // Set restrictive permissions for .env files (contain secrets)
        if (cf.name.endsWith('.env')) {
          await client.exec(`chmod 600 "${cfPath}"`);
        }
      }

      // Save artifacts to database
      await saveDeploymentArtifacts(deployment.id, artifacts);
      log('Artifacts saved');

      // Update service compose path only if it wasn't already set
      if (!service.composePath) {
        await prisma.service.update({
          where: { id: serviceId },
          data: { composePath },
        });
        service.composePath = composePath;
      }
    }

    // Pull new image
    if (options.pullImage !== false) {
      const fullImage = `${service.imageName}:${imageTag}`;
      log(`Pulling image: ${fullImage}`);
      await docker.pullImage(fullImage);
      log('Image pulled successfully');
    }

    // Deploy using compose or direct container
    if (service.composePath) {
      log(`Running docker compose up for ${service.composePath}`);
      await docker.composePull(service.composePath, service.containerName);
      await docker.composeUp(service.composePath, service.containerName);
      log('Compose up completed');
    } else {
      log(`Restarting container: ${service.containerName}`);
      await docker.restartContainer(service.containerName);
      log('Container restarted');
    }

    // Verify container is running
    const containers = await docker.listContainers();
    const container = containers.find((c) => c.name === service.containerName);

    if (!container || container.state !== 'running') {
      throw new Error(`Container ${service.containerName} is not running after deploy`);
    }

    log(`Container ${service.containerName} is running`);

    client.disconnect();

    // Update service record
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        imageTag,
        status: 'running',
        lastCheckedAt: new Date(),
      },
    });

    // Check for available image updates in background (don't block deploy)
    checkServiceUpdate(serviceId).catch((err) => {
      console.error(`[Deploy] Failed to check updates for service ${serviceId}:`, err);
    });

    // Mark deployment as successful
    const finalDeployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'success',
        logs: logs.join('\n'),
        completedAt: new Date(),
      },
    });

    return { deployment: finalDeployment, logs: logs.join('\n') };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);

    const failedDeployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'failed',
        logs: logs.join('\n'),
        completedAt: new Date(),
      },
    });

    return { deployment: failedDeployment, logs: logs.join('\n') };
  }
}

export async function getDeploymentHistory(
  serviceId: string,
  limit: number = 20
): Promise<Deployment[]> {
  return prisma.deployment.findMany({
    where: { serviceId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function getDeployment(deploymentId: string): Promise<Deployment | null> {
  return prisma.deployment.findUnique({
    where: { id: deploymentId },
  });
}

export async function getContainerLogs(
  serviceId: string,
  tail: number = 100
): Promise<string> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: { server: true },
  });

  // Create appropriate client based on hostname
  const { client, error: clientError } = await createClientForServer(
    service.server.hostname,
    service.server.environmentId,
    getEnvironmentSshKey
  );
  if (!client) {
    throw new Error(clientError || 'Failed to create SSH client');
  }

  const docker = new DockerSSH(client);

  try {
    await client.connect();
    return await docker.containerLogs(service.containerName, { tail });
  } finally {
    client.disconnect();
  }
}

export async function getLatestImageTags(
  repositoryName: string,
  limit: number = 10
): Promise<Array<{ tag: string; updatedAt: string }>> {
  const tags = await registryClient.listTags(repositoryName);

  return tags
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((t) => ({ tag: t.tag, updatedAt: t.updatedAt }));
}
