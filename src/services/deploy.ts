import { prisma } from '../lib/db.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost, type CommandClient } from '../lib/ssh.js';
import { registryClient } from '../lib/registry.js';
import { generateDeploymentArtifacts, saveDeploymentArtifacts } from './compose.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
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
    let client: CommandClient;
    if (isLocalhost(service.server.hostname)) {
      client = new LocalClient();
      log('Using local execution for localhost');
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

    await client.connect();
    log(`Connected to ${service.server.name} (${service.server.hostname})`);

    // Determine deploy directory
    const deployDir = service.composePath
      ? service.composePath.replace(/[^/]+$/, '')
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

      // Upload compose file
      log(`Writing ${artifacts.compose.name}`);
      const composePath = `${deployDir}/${artifacts.compose.name}`;
      await client.exec(`cat > ${composePath} << 'COMPOSEEOF'\n${artifacts.compose.content}\nCOMPOSEEOF`);

      // Upload env file if generated
      if (artifacts.envFile) {
        log(`Writing ${artifacts.envFile.name}`);
        const envPath = `${deployDir}/${artifacts.envFile.name}`;
        await client.exec(`cat > ${envPath} << 'ENVEOF'\n${artifacts.envFile.content}\nENVEOF`);
        await client.exec(`chmod 600 ${envPath}`);
      }

      // Upload config files
      for (const cf of artifacts.configFiles) {
        log(`Writing config file: ${cf.name}`);
        const cfPath = `${deployDir}/${cf.name}`;
        await client.exec(`cat > ${cfPath} << 'CFEOF'\n${cf.content}\nCFEOF`);
      }

      // Save artifacts to database
      await saveDeploymentArtifacts(deployment.id, artifacts);
      log('Artifacts saved');

      // Update service compose path
      await prisma.service.update({
        where: { id: serviceId },
        data: { composePath },
      });

      service.composePath = composePath;
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
  let client: CommandClient;
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
