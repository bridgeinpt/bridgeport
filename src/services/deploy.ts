import path from 'path';
import { prisma } from '../lib/db.js';
import { DockerSSH, createClientForServer, shellEscape, type CommandClient } from '../lib/ssh.js';
import { createDockerClientForServer, type DockerClient } from '../lib/docker.js';
import { RegistryFactory } from '../lib/registry.js';
import { getRegistryCredentials } from './registries.js';
import { extractRepoName, stripRegistryPrefix } from '../lib/image-utils.js';
import { generateDeploymentArtifacts, saveDeploymentArtifacts } from './compose.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { pruneServerImages } from './servers.js';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';
import { recordTagDeployment } from './image-management.js';
import { safeJsonParse } from '../lib/helpers.js';
import { eventBus } from '../lib/event-bus.js';
import { DEPLOYMENT_STATUS, CONTAINER_STATUS, HISTORY_STATUS } from '../lib/constants.js';
import type { Deployment, Service } from '@prisma/client';

export interface DeployOptions {
  imageTag?: string;
  generateArtifacts?: boolean;  // Generate compose, env, config files
  pullImage?: boolean;
}

export interface DeployResult {
  deployment: Deployment;
  logs: string;
  previousTag: string | null;
}

export async function deployService(
  serviceId: string,
  triggeredBy: string,
  userId: string | null,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const startTime = Date.now(); // Track deployment duration

  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: {
      server: {
        include: { environment: true },
      },
      containerImage: true,
    },
  });

  const imageTag = options.imageTag || service.imageTag;
  const previousTag = service.imageTag; // Store previous tag for rollback
  const logs: string[] = [];

  // Create deployment record with previousTag for rollback support
  const deployment = await prisma.deployment.create({
    data: {
      imageTag,
      previousTag,
      status: DEPLOYMENT_STATUS.PENDING,
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
      data: { status: DEPLOYMENT_STATUS.DEPLOYING },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deployment.id, serviceId, status: DEPLOYMENT_STATUS.DEPLOYING, environmentId: service.server.environmentId } });

    log(`Starting deployment of ${service.name} with tag ${imageTag}`);

    // Create appropriate Docker client based on server's dockerMode
    const { dockerClient, sshClient, error: clientError, mode, needsConnect } = await createDockerClientForServer(
      {
        hostname: service.server.hostname,
        dockerMode: service.server.dockerMode,
        serverType: service.server.serverType,
        environmentId: service.server.environmentId,
      },
      getEnvironmentSshKey
    );

    if (!dockerClient) {
      throw new Error(clientError || 'Failed to create Docker client');
    }

    // Connect SSH client if needed (for file operations or SSH-mode Docker)
    if (needsConnect && sshClient) {
      await sshClient.connect();
    }

    // For compose operations, we still need the DockerSSH wrapper (uses SSH for compose commands)
    // TODO: In the future, could add compose support to socket mode
    const dockerSSH = sshClient ? new DockerSSH(sshClient) : null;

    log(`Connected to ${service.server.name} (${mode} mode)`);

    // Determine deploy directory (use path.dirname to properly handle any path)
    const deployDir = service.composePath
      ? path.dirname(service.composePath)
      : `/opt/${service.name}`;

    // File operations require SSH client (even in socket mode)
    if (sshClient) {
      await sshClient.exec(`mkdir -p ${shellEscape(deployDir)}`);
    }

    // Generate deployment artifacts (compose, env, config files)
    if (options.generateArtifacts !== false && sshClient) {
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
      await sshClient.exec(`cat > ${shellEscape(composePath)} << 'COMPOSEEOF'\n${artifacts.compose.content}\nCOMPOSEEOF`);

      // Upload config files to their configured target paths
      for (const cf of artifacts.configFiles) {
        // Use the configured mountPath (targetPath) for the file
        const cfPath = cf.mountPath;

        // Ensure target directory exists
        const cfDir = path.dirname(cfPath);
        await sshClient.exec(`mkdir -p ${shellEscape(cfDir)}`);

        log(`Writing config file: ${cf.name} -> ${cfPath}`);

        if (cf.isBinary) {
          // Binary files: use SFTP for reliable transfer of large files
          const fileBuffer = Buffer.from(cf.content, 'base64');
          await sshClient.writeFile(cfPath, fileBuffer);
        } else {
          // Text files: use heredoc
          await sshClient.exec(`cat > ${shellEscape(cfPath)} << 'CFEOF'\n${cf.content}\nCFEOF`);
        }

        // Set restrictive permissions for .env files (contain secrets)
        if (cf.name.endsWith('.env')) {
          await sshClient.exec(`chmod 600 ${shellEscape(cfPath)}`);
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

    // Pull new image (get imageName from containerImage)
    if (options.pullImage !== false) {
      const imageName = service.containerImage.imageName;
      const fullImage = `${imageName}:${imageTag}`;
      log(`Pulling image: ${fullImage}`);
      await dockerClient.pullImage(fullImage);
      log('Image pulled successfully');
    }

    // Deploy using compose or direct container
    if (service.composePath && dockerSSH) {
      // Compose operations still require SSH (docker compose commands)
      log(`Running docker compose up for ${service.composePath}`);
      await dockerSSH.composePull(service.composePath, service.containerName);
      await dockerSSH.composeUp(service.composePath, service.containerName);
      log('Compose up completed');
    } else {
      log(`Restarting container: ${service.containerName}`);
      await dockerClient.restartContainer(service.containerName);
      log('Container restarted');
    }

    // Verify container is running
    const containers = await dockerClient.listContainers();
    const container = containers.find((c) => c.name === service.containerName);

    if (!container || container.state !== CONTAINER_STATUS.RUNNING) {
      throw new Error(`Container ${service.containerName} is not running after deploy`);
    }

    log(`Container ${service.containerName} is running`);

    if (sshClient) {
      sshClient.disconnect();
    }

    // Update service record
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        imageTag,
        status: CONTAINER_STATUS.RUNNING,
        lastCheckedAt: new Date(),
      },
    });

    // Check for available image updates in background (don't block deploy)
    checkServiceUpdate(serviceId).catch((err) => {
      console.error(`[Deploy] Failed to check updates for service ${serviceId}:`, err);
    });

    // Auto-prune images if enabled for this environment (non-blocking)
    prisma.operationsSettings.findUnique({
      where: { environmentId: service.server.environmentId },
      select: { autoPruneImages: true, pruneImagesMode: true },
    }).then((opSettings) => {
      if (opSettings?.autoPruneImages) {
        const mode = (opSettings.pruneImagesMode as 'dangling' | 'all') ?? 'dangling';
        pruneServerImages(service.server, mode)
          .then(({ spaceReclaimedBytes }) => {
            if (spaceReclaimedBytes > 0) log(`[Auto-prune] Freed ${spaceReclaimedBytes} bytes on ${service.server.name}`);
          })
          .catch(err => console.error('[Deploy] Auto-prune failed:', err));
      }
    }).catch(err => console.error('[Deploy] Failed to check auto-prune settings:', err));

    // Record successful deployment in container image history
    const historyEntry = await recordTagDeployment(
      service.containerImage.id,
      imageTag,
      undefined,
      triggeredBy,
      HISTORY_STATUS.SUCCESS
    );

    // Mark deployment as successful and link to history entry
    const durationMs = Date.now() - startTime;
    const finalDeployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: DEPLOYMENT_STATUS.SUCCESS,
        logs: logs.join('\n'),
        completedAt: new Date(),
        durationMs,
        containerImageHistoryId: historyEntry.id,
      },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deployment.id, serviceId, status: DEPLOYMENT_STATUS.SUCCESS, environmentId: service.server.environmentId } });

    // Collect all tags for the deployed digest to include in notification
    let imageTags: string[] = [];
    if (historyEntry.imageDigestId) {
      const digest = await prisma.imageDigest.findUnique({
        where: { id: historyEntry.imageDigestId },
        select: { tags: true },
      });
      imageTags = safeJsonParse(digest?.tags as string, [] as string[]);
    }

    // Send success notification
    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
      service.server.environmentId,
      {
        serviceName: service.name,
        imageTag,
        imageTags,
        serverName: service.server.name,
      }
    );

    return { deployment: finalDeployment, logs: logs.join('\n'), previousTag };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);

    // Record failed deployment in container image history
    const historyEntry = await recordTagDeployment(
      service.containerImage.id,
      imageTag,
      undefined,
      triggeredBy,
      HISTORY_STATUS.FAILED
    );

    const durationMs = Date.now() - startTime;
    const failedDeployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: DEPLOYMENT_STATUS.FAILED,
        logs: logs.join('\n'),
        completedAt: new Date(),
        durationMs,
        containerImageHistoryId: historyEntry.id,
      },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deployment.id, serviceId, status: DEPLOYMENT_STATUS.FAILED, environmentId: service.server.environmentId } });

    // Send failure notification
    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
      service.server.environmentId,
      {
        serviceName: service.name,
        serviceId: service.id,
        imageTag,
        serverName: service.server.name,
        error: errorMessage,
      }
    );

    return { deployment: failedDeployment, logs: logs.join('\n'), previousTag };
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

  // Create appropriate Docker client based on server's dockerMode
  const { dockerClient, sshClient, error: clientError, needsConnect } = await createDockerClientForServer(
    {
      hostname: service.server.hostname,
      dockerMode: service.server.dockerMode,
      serverType: service.server.serverType,
      environmentId: service.server.environmentId,
    },
    getEnvironmentSshKey
  );

  if (!dockerClient) {
    throw new Error(clientError || 'Failed to create Docker client');
  }

  try {
    if (needsConnect && sshClient) {
      await sshClient.connect();
    }
    return await dockerClient.getContainerLogs(service.containerName, { tail });
  } finally {
    if (sshClient) {
      sshClient.disconnect();
    }
  }
}

export async function getLatestImageTags(
  serviceId: string,
  limit: number = 10
): Promise<Array<{ tag: string; updatedAt: string }>> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { containerImage: true },
  });

  if (!service?.containerImage) {
    throw new Error('Service or container image not found');
  }

  if (!service.containerImage.registryConnectionId) {
    throw new Error('No registry connection configured for this service');
  }

  const creds = await getRegistryCredentials(service.containerImage.registryConnectionId);
  if (!creds) {
    throw new Error('Could not get registry credentials');
  }

  const client = RegistryFactory.create(creds);
  const repoName = creds.type === 'digitalocean'
    ? extractRepoName(service.containerImage.imageName, creds.repositoryPrefix)
    : stripRegistryPrefix(service.containerImage.imageName);
  const tags = await client.listTags(repoName);

  return tags
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((t) => ({ tag: t.tag, updatedAt: t.updatedAt }));
}
