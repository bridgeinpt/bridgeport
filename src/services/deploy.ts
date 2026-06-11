import path from 'path';
import { prisma } from '../lib/db.js';
import { DockerSSH, shellEscape, type CommandClient } from '../lib/ssh.js';
import { createDockerClientForServer, type DockerClient } from '../lib/docker.js';
import { RegistryFactory } from '../lib/registry.js';
import { getRegistryCredentials } from './registries.js';
import { extractRepoName, stripRegistryPrefix } from '../lib/image-utils.js';
import { generateDeploymentArtifacts, previewDryRunArtifacts, saveDeploymentArtifacts, validateGeneratedCompose } from './compose.js';
import { logAudit } from './audit.js';
import { ensureRegistryLogin, getSocketAuthConfig } from './registry-login.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { pruneServerImages } from './servers.js';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';
import { emitWebhookEvent } from './webhook-subscriptions.js';
import { recordTagDeployment } from './image-management.js';
import { safeJsonParse, getErrorMessage } from '../lib/helpers.js';
import { runExclusive } from '../lib/keyed-lock.js';
import { getSystemSettings } from './system-settings.js';
import { eventBus } from '../lib/event-bus.js';
import { DEPLOYMENT_STATUS, CONTAINER_STATUS, HISTORY_STATUS, DISCOVERY_STATUS } from '../lib/constants.js';
import type { Deployment } from '@prisma/client';
import type { ContainerAction, DeployDryRunReport } from '../lib/dry-run.js';

export interface DeployOptions {
  imageTag?: string;
  generateArtifacts?: boolean;  // Generate compose, env, config files
  pullImage?: boolean;
  /**
   * Override the `previousTag` recorded on the new Deployment row. Used by
   * deployServiceTemplate to ensure every fan-out deployment records the same
   * pre-rollout tag, instead of seeing the updated tag from earlier siblings.
   */
  previousTagOverride?: string | null;
}

export interface DeployResult {
  deployment: Deployment;
  logs: string;
  previousTag: string | null;
}

/**
 * Deploy a single ServiceDeployment (per-server).
 * The `imageTag` ultimately lives on the parent Service (shared across all deployments
 * in 2.0). `options.imageTag` updates the template's tag before deploying.
 */
export async function deployService(
  serviceDeploymentId: string,
  triggeredBy: string,
  userId: string | null,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const startTime = Date.now();

  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: {
      server: { include: { environment: true } },
      service: { include: { containerImage: true } },
    },
  });

  const service = deployment.service;
  const imageTag = options.imageTag || service.imageTag;
  // When fanning out via deployServiceTemplate, the caller passes in the
  // template-level imageTag captured BEFORE any deployment ran so every
  // fan-out Deployment row records the same pre-rollout tag for rollback.
  const previousTag = options.previousTagOverride !== undefined ? options.previousTagOverride : service.imageTag;
  const logs: string[] = [];

  // Create deployment record. Denormalize serviceId so historical UI queries
  // don't need a 3-way join through ServiceDeployment.
  const deploymentRow = await prisma.deployment.create({
    data: {
      imageTag,
      previousTag,
      status: DEPLOYMENT_STATUS.PENDING,
      triggeredBy,
      serviceId: service.id,
      serviceDeploymentId,
      userId,
    },
  });

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${message}`);
  };

  // Hoisted so the catch block can also capture container logs on failure
  let dockerClient: DockerClient | null = null;
  let sshClient: CommandClient | null = null;

  // Tracks whether a successful capture has already happened, so the catch
  // block doesn't re-invoke against an already-disconnected client and append
  // a misleading "unavailable" note after the real logs.
  let containerLogsCaptured = false;

  // Append `docker logs <container>` output (best-effort) so deployment plan view
  // surfaces internal container output without needing SSH access. Safe to call
  // when the container doesn't exist — failures are recorded as a note.
  const captureContainerLogs = async () => {
    if (!dockerClient) return;
    if (containerLogsCaptured) return;
    try {
      const settings = await getSystemSettings();
      const tail = settings.defaultLogLines;
      const containerLogs = await dockerClient.getContainerLogs(deployment.containerName, {
        tail,
        timestamps: true,
      });
      logs.push(`\n--- container logs (${deployment.containerName}, last ${tail} lines) ---`);
      logs.push(containerLogs.trim() || '(no output)');
      // Only mark as captured on the success path so a transient failure can
      // still be retried from the catch block.
      containerLogsCaptured = true;
    } catch (err) {
      logs.push(
        `\n--- container logs unavailable (${deployment.containerName}): ${getErrorMessage(err, 'unknown error')} ---`
      );
    }
  };

  try {
    await prisma.deployment.update({
      where: { id: deploymentRow.id },
      data: { status: DEPLOYMENT_STATUS.DEPLOYING },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deploymentRow.id, serviceId: service.id, status: DEPLOYMENT_STATUS.DEPLOYING, environmentId: deployment.server.environmentId } });

    log(`Starting deployment of ${service.name} on ${deployment.server.name} with tag ${imageTag}`);

    // Create appropriate Docker client based on server's dockerMode
    const { dockerClient: createdClient, sshClient: createdSsh, error: clientError, mode, needsConnect } = await createDockerClientForServer(
      {
        hostname: deployment.server.hostname,
        dockerMode: deployment.server.dockerMode,
        serverType: deployment.server.serverType,
        environmentId: deployment.server.environmentId,
      },
      getEnvironmentSshKey
    );

    dockerClient = createdClient;
    sshClient = createdSsh;

    if (!dockerClient) {
      throw new Error(clientError || 'Failed to create Docker client');
    }

    if (needsConnect && sshClient) {
      await sshClient.connect();
    }

    // For compose operations, we still need the DockerSSH wrapper (uses SSH for compose commands)
    const dockerSSH = sshClient ? new DockerSSH(sshClient) : null;

    log(`Connected to ${deployment.server.name} (${mode} mode)`);

    // Determine deploy directory
    const deployDir = deployment.composePath
      ? path.dirname(deployment.composePath)
      : `/opt/${service.name}`;

    // File operations require SSH client (even in socket mode)
    if (sshClient) {
      await sshClient.exec(`mkdir -p ${shellEscape(deployDir)}`);
    }

    // Generate deployment artifacts (compose, env, config files)
    if (options.generateArtifacts !== false && sshClient) {
      log('Generating deployment artifacts...');

      // Sync the image tag onto the template before generating artifacts.
      // imageTag is shared across all deployments in 2.0.
      if (imageTag !== service.imageTag) {
        await prisma.service.update({
          where: { id: service.id },
          data: { imageTag },
        });
      }

      const artifacts = await generateDeploymentArtifacts(serviceDeploymentId);

      // Upload compose file (preserve existing path if set, otherwise use generated name)
      const composePath = deployment.composePath || `${deployDir}/${artifacts.compose.name}`;

      // Never auto-rewrite a compose file that is operator-set AND shared by more
      // than one BRIDGEPORT deployment: the generator emits a single-service
      // document, so writing it would wipe the sibling services from a
      // hand-maintained file. For those, we trust the existing file on disk and
      // only validate that it already targets this deployment's service. (issue #200)
      const operatorSetPath = deployment.composePath !== null;
      const siblingCount = operatorSetPath
        ? await prisma.serviceDeployment.count({
            where: { serverId: deployment.serverId, composePath },
          })
        : 0;
      const sharedOperatorFile = operatorSetPath && siblingCount > 1;

      // Validate before writing/deploying: the deploy path runs
      // `docker compose pull/up <containerName>`, so the compose file MUST define
      // a service keyed on this deployment's containerName. For a shared operator
      // file we read the actual file on disk (it has multiple services); otherwise
      // we validate the generated/template content we're about to write. Refuse
      // loudly rather than aborting at compose-up with "No such service" while the
      // stale container keeps running. (issue #200)
      let composeToValidate = artifacts.compose.content;
      if (sharedOperatorFile) {
        const existing = await sshClient.exec(`cat ${shellEscape(composePath)}`);
        if (existing.code !== 0) {
          throw new Error(
            `Failed to read shared compose file at ${composePath}: ${existing.stderr.trim() || 'file not found'}`
          );
        }
        composeToValidate = existing.stdout;
      }
      const composeValidationError = validateGeneratedCompose(
        composeToValidate,
        deployment.containerName
      );
      if (composeValidationError) {
        throw new Error(composeValidationError);
      }

      if (sharedOperatorFile) {
        log(`Compose file ${composePath} is shared and operator-maintained; not rewriting it`);
      } else {
        log(`Writing compose file to ${composePath}`);
        // Write to a per-deployment temp file then atomically rename into place.
        // Multiple BRIDGEPORT services can share one compose file; two concurrent
        // deploys doing a plain `cat >` to the same path could interleave into a
        // half-written, unparseable file. `mv` on the same directory is atomic.
        const composeTmp = `${composePath}.tmp.${deploymentRow.id}`;
        await sshClient.exec(`cat > ${shellEscape(composeTmp)} << 'COMPOSEEOF'\n${artifacts.compose.content}\nCOMPOSEEOF`);
        await sshClient.exec(`mv -f ${shellEscape(composeTmp)} ${shellEscape(composePath)}`);
      }

      // Upload config files to their configured target paths
      for (const cf of artifacts.configFiles) {
        const cfPath = cf.mountPath;

        // Ensure target directory exists
        const cfDir = path.dirname(cfPath);
        await sshClient.exec(`mkdir -p ${shellEscape(cfDir)}`);

        log(`Writing config file: ${cf.name} -> ${cfPath}`);

        if (cf.isBinary) {
          // Binary files: use SFTP for reliable transfer
          const fileBuffer = Buffer.from(cf.content, 'base64');
          await sshClient.writeFile(cfPath, fileBuffer);
        } else {
          await sshClient.exec(`cat > ${shellEscape(cfPath)} << 'CFEOF'\n${cf.content}\nCFEOF`);
        }

        // Set restrictive permissions for .env files (contain secrets)
        if (cf.name.endsWith('.env')) {
          await sshClient.exec(`chmod 600 ${shellEscape(cfPath)}`);
        }
      }

      await saveDeploymentArtifacts(deploymentRow.id, artifacts);
      log('Artifacts saved');

      // Auto-set the deployment's composePath ONLY when it is currently null AND
      // the per-environment opt-in is enabled (default OFF). A non-null
      // composePath is NEVER overwritten — operator intent and hand-maintained
      // compose files are sacrosanct. Every change is audit-logged with its
      // source so the rewrite is traceable. (issue #200)
      if (!deployment.composePath) {
        const opSettings = await prisma.operationsSettings.findUnique({
          where: { environmentId: deployment.server.environmentId },
          select: { autoManageCompose: true },
        });
        if (opSettings?.autoManageCompose) {
          await prisma.serviceDeployment.update({
            where: { id: serviceDeploymentId },
            data: { composePath },
          });
          deployment.composePath = composePath;
          await logAudit({
            action: 'service_deployment_compose_path_set',
            resourceType: 'service_deployment',
            resourceId: serviceDeploymentId,
            resourceName: deployment.containerName,
            environmentId: deployment.server.environmentId,
            userId: userId ?? undefined,
            details: { source: 'generator', composePath },
          });
        } else {
          log(
            'Auto-managed compose is disabled for this environment; leaving composePath unset. ' +
            'Enable "Auto-Manage Compose Files" in Operations settings or set a compose path manually to deploy via compose.'
          );
        }
      }
    }

    // Ensure registry auth
    const registryConnectionId = service.containerImage.registryConnectionId;
    let socketAuth: Awaited<ReturnType<typeof getSocketAuthConfig>> = null;
    if (registryConnectionId) {
      if (dockerSSH) {
        const result = await ensureRegistryLogin(
          deployment.server.id,
          registryConnectionId,
          dockerSSH
        );
        if (result.loggedIn) {
          log(`Logged in to registry ${result.registryHost || 'docker.io'}`);
        }
      } else {
        socketAuth = await getSocketAuthConfig(registryConnectionId);
      }
    }

    // Pull new image
    if (options.pullImage !== false) {
      const imageName = service.containerImage.imageName;
      const fullImage = `${imageName}:${imageTag}`;
      log(`Pulling image: ${fullImage}`);
      await dockerClient.pullImage(fullImage, socketAuth ?? undefined);
      log('Image pulled successfully');
    }

    // Deploy using compose or direct container
    if (deployment.composePath && dockerSSH) {
      const composePath = deployment.composePath;
      const ssh = dockerSSH;
      log(`Running docker compose up for ${composePath}`);
      // When this compose file backs more than one BRIDGEPORT deployment on this
      // server, each sibling owns its own service, so suppress dependency
      // cascade (--no-deps) to avoid recreating (and racing on) a sibling's
      // container. A standalone compose file keeps default behavior so a
      // service's own un-tracked dependencies still come up.
      const deploymentsOnComposeFile = await prisma.serviceDeployment.count({
        where: { serverId: deployment.serverId, composePath },
      });
      const sharedCompose = deploymentsOnComposeFile > 1;
      // Serialize compose ops per (server, compose file): multiple BRIDGEPORT
      // services can share one docker-compose.yml, and concurrent
      // `compose up --force-recreate` runs race on recreating shared/dependency
      // containers ("removal of container ... is already in progress"). One
      // deploy touches a given file at a time.
      await runExclusive(`${deployment.serverId}::${composePath}`, async () => {
        await ssh.composePull(composePath, deployment.containerName);
        await ssh.composeUp(composePath, deployment.containerName, true, sharedCompose);
      });
      log('Compose up completed');
    } else {
      log(`Restarting container: ${deployment.containerName}`);
      await dockerClient.restartContainer(deployment.containerName);
      log('Container restarted');
    }

    // Verify container is running
    const containers = await dockerClient.listContainers();
    const container = containers.find((c) => c.name === deployment.containerName);

    if (!container || container.state !== CONTAINER_STATUS.RUNNING) {
      throw new Error(`Container ${deployment.containerName} is not running after deploy`);
    }

    log(`Container ${deployment.containerName} is running`);

    // Capture container output so deploy plan view shows internal logs without SSH
    await captureContainerLogs();

    if (sshClient) {
      sshClient.disconnect();
    }

    // Update deployment record - lastDeployedAt and runtime status. Flip
    // discoveryStatus to 'found' so the scheduler's health-check filter picks
    // it up (manually-created deployments start as 'pending').
    await prisma.serviceDeployment.update({
      where: { id: serviceDeploymentId },
      data: {
        status: CONTAINER_STATUS.RUNNING,
        discoveryStatus: DISCOVERY_STATUS.FOUND,
        lastCheckedAt: new Date(),
        lastDeployedAt: new Date(),
      },
    });

    // Check for available image updates in background
    checkServiceUpdate(serviceDeploymentId).catch(() => {
      console.error('[Deploy] Failed to check updates for deployment', serviceDeploymentId);
    });

    // Auto-prune images if enabled
    prisma.operationsSettings.findUnique({
      where: { environmentId: deployment.server.environmentId },
      select: { autoPruneImages: true, pruneImagesMode: true },
    }).then((opSettings) => {
      if (opSettings?.autoPruneImages) {
        const mode = (opSettings.pruneImagesMode as 'dangling' | 'all') ?? 'dangling';
        pruneServerImages(deployment.server, mode)
          .then(({ spaceReclaimedBytes }) => {
            if (spaceReclaimedBytes > 0) log(`[Auto-prune] Freed ${spaceReclaimedBytes} bytes on ${deployment.server.name}`);
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
      where: { id: deploymentRow.id },
      data: {
        status: DEPLOYMENT_STATUS.SUCCESS,
        logs: logs.join('\n'),
        completedAt: new Date(),
        durationMs,
        containerImageHistoryId: historyEntry.id,
      },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deploymentRow.id, serviceId: service.id, status: DEPLOYMENT_STATUS.SUCCESS, environmentId: deployment.server.environmentId } });

    // Collect all tags for the deployed digest to include in notification
    let imageTags: string[] = [];
    if (historyEntry.imageDigestId) {
      const digest = await prisma.imageDigest.findUnique({
        where: { id: historyEntry.imageDigestId },
        select: { tags: true },
      });
      imageTags = safeJsonParse(digest?.tags as string, [] as string[]);
    }

    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
      deployment.server.environmentId,
      {
        serviceName: service.name,
        serviceId: service.id,
        imageName: service.containerImage.imageName,
        imageTag,
        imageTags,
        serverName: deployment.server.name,
      }
    );

    // Fire-and-forget webhook event (issue #126). emitWebhookEvent never throws.
    void emitWebhookEvent('deployment.completed', deployment.server.environmentId, {
      deploymentId: finalDeployment.id,
      serviceId: service.id,
      serviceName: service.name,
      serverName: deployment.server.name,
      imageName: service.containerImage.imageName,
      imageTag,
      status: DEPLOYMENT_STATUS.SUCCESS,
    });

    return { deployment: finalDeployment, logs: logs.join('\n'), previousTag };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);

    // Capture container output (best-effort) so failed deploys surface internal
    // logs in the deployment plan view without requiring SSH access.
    await captureContainerLogs();

    if (sshClient) {
      try { sshClient.disconnect(); } catch { /* ignore */ }
    }

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
      where: { id: deploymentRow.id },
      data: {
        status: DEPLOYMENT_STATUS.FAILED,
        logs: logs.join('\n'),
        completedAt: new Date(),
        durationMs,
        containerImageHistoryId: historyEntry.id,
      },
    });

    eventBus.emitEvent({ type: 'deployment_progress', data: { deploymentId: deploymentRow.id, serviceId: service.id, status: DEPLOYMENT_STATUS.FAILED, environmentId: deployment.server.environmentId } });

    await sendSystemNotification(
      NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
      deployment.server.environmentId,
      {
        serviceName: service.name,
        serviceId: service.id,
        imageName: service.containerImage.imageName,
        imageTag,
        serverName: deployment.server.name,
        error: errorMessage,
      }
    );

    // Fire-and-forget webhook event (issue #126). emitWebhookEvent never throws.
    void emitWebhookEvent('deployment.failed', deployment.server.environmentId, {
      deploymentId: failedDeployment.id,
      serviceId: service.id,
      serviceName: service.name,
      serverName: deployment.server.name,
      imageName: service.containerImage.imageName,
      imageTag,
      status: DEPLOYMENT_STATUS.FAILED,
      error: errorMessage,
    });

    return { deployment: failedDeployment, logs: logs.join('\n'), previousTag };
  }
}

/**
 * Resolve digest + container action for the dry-run report.
 * Split from the main builder so the SSH inspect step can be retried/skipped
 * without re-doing the registry call.
 */
async function resolveDigestAndAction(
  containerImage: { imageName: string; registryConnectionId: string | null },
  imageTag: string,
  server: { hostname: string; dockerMode: string; serverType: string; environmentId: string },
  containerName: string
): Promise<{ digest: string | null; action: ContainerAction; warnings: string[] }> {
  const warnings: string[] = [];

  // Resolve the new digest from the registry (no pull).
  let newDigest: string | null = null;
  if (containerImage.registryConnectionId) {
    try {
      const creds = await getRegistryCredentials(containerImage.registryConnectionId);
      if (!creds) {
        warnings.push('Registry credentials not found — digest cannot be resolved');
      } else {
        const client = RegistryFactory.create(creds);
        const repoName = creds.type === 'digitalocean'
          ? extractRepoName(containerImage.imageName, creds.repositoryPrefix)
          : stripRegistryPrefix(containerImage.imageName);
        newDigest = await client.getManifestDigest(repoName, imageTag);
      }
    } catch (err) {
      warnings.push(`Failed to resolve image digest from registry: ${getErrorMessage(err, 'unknown error')}`);
    }
  } else {
    warnings.push('No registry connection configured — digest cannot be resolved without a pull');
  }

  // Inspect the running container's current image to decide cycle vs no-op.
  // Failures here are non-fatal — fall back to `cycle` (the safe default).
  let action: ContainerAction = 'cycle';
  try {
    const { dockerClient, sshClient, needsConnect } = await createDockerClientForServer(server, getEnvironmentSshKey);
    if (!dockerClient) {
      warnings.push('Could not connect to server to inspect current container');
    } else {
      try {
        if (needsConnect && sshClient) {
          await sshClient.connect();
        }
        const info = await dockerClient.getContainerInfo(containerName);
        if (!info.running || info.state === CONTAINER_STATUS.NOT_FOUND) {
          action = 'start';
        } else if (newDigest && info.image) {
          // info.image is the image reference (e.g. "repo/img:tag"); we can't
          // compare it to a registry manifest digest directly. The dry-run
          // therefore optimistically reports `cycle` whenever a container is
          // running — a real comparison would require inspecting the local
          // image's RepoDigests, which is mode-specific. This is documented
          // explicitly so callers don't read `cycle` as "definitely will
          // restart".
          action = 'cycle';
        }
      } finally {
        if (sshClient) {
          try { sshClient.disconnect(); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    warnings.push(`Could not inspect running container: ${getErrorMessage(err, 'unknown error')}`);
  }

  return { digest: newDigest, action, warnings };
}

/**
 * Dry-run preview of `deployService`. Renders the artifacts the real path
 * would write to the host and reports the resolved image digest + the action
 * Docker would take — without creating a Deployment row, opening a writeable
 * SSH session, or pulling the image.
 *
 * Secret VALUES in the compose content and env map are replaced with `***`;
 * `${KEY}` references in the source template that would normally be substituted
 * remain visible via the substituted-then-redacted form.
 */
export interface DeployServiceDryRunOptions {
  /**
   * Override the image tag previewed by the dry-run (mirrors
   * `DeployOptions.imageTag` on the real path). Used by plan dry-runs so each
   * step previews `step.targetTag` rather than the current Service tag.
   */
  imageTag?: string;
}

export async function deployServiceDryRun(
  serviceDeploymentId: string,
  options: DeployServiceDryRunOptions = {}
): Promise<DeployDryRunReport> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: {
      server: true,
      service: { include: { containerImage: true } },
    },
  });

  const service = deployment.service;
  // Resolve the effective tag the real `deployService` would have used given
  // these options. The override must flow into BOTH digest resolution and the
  // compose preview — otherwise the report would show one tag in `imageTag`
  // and another in the rendered compose.
  const imageTag = options.imageTag || service.imageTag;

  // Render the artifacts with secrets redacted. previewDryRunArtifacts mirrors
  // generateDeploymentArtifacts but replaces secret values with `***`.
  const preview = await previewDryRunArtifacts(serviceDeploymentId, { imageTag });

  const { digest, action, warnings } = await resolveDigestAndAction(
    {
      imageName: service.containerImage.imageName,
      registryConnectionId: service.containerImage.registryConnectionId,
    },
    imageTag,
    {
      hostname: deployment.server.hostname,
      dockerMode: deployment.server.dockerMode,
      serverType: deployment.server.serverType,
      environmentId: deployment.server.environmentId,
    },
    deployment.containerName
  );

  // Mirror the real deploy's pre-flight compose check (deployService): if the
  // rendered compose's top-level service key doesn't match containerName, the
  // live deploy refuses. Surface that as a warning here (informational — a
  // dry-run must still return a report) so the preview isn't misleadingly
  // green for the exact failure mode issue #200 targets.
  const composeValidationError = validateGeneratedCompose(
    preview.composeContent,
    deployment.containerName
  );

  return {
    dryRun: true,
    serviceId: service.id,
    serviceDeploymentId,
    serverName: deployment.server.name,
    imageTag,
    imageDigest: digest,
    composeContent: preview.composeContent,
    env: preview.env,
    containerAction: action,
    warnings: [
      ...preview.warnings,
      ...warnings,
      ...(composeValidationError ? [composeValidationError] : []),
    ],
    // Propagate would-fail status from the artifact preview. The live deploy
    // throws on template errors and refuses missing secrets — surface that
    // structurally so the dry-run report doesn't look "green" when it isn't.
    ...(preview.wouldFail
      ? { wouldSucceed: false, error: preview.failureReason ?? 'Artifact generation would fail' }
      : {}),
  };
}

/**
 * Deploy a Service template across all its ServiceDeployments.
 * Strategy:
 *  - 'sequential' (default): deploy one at a time, halt on first failure.
 *  - 'parallel': fan out concurrently to all servers.
 */
export interface DeployServiceTemplateOptions extends DeployOptions {
  strategy?: 'sequential' | 'parallel';
}

export interface DeployServiceTemplateResult {
  results: Array<{ serviceDeploymentId: string; result: DeployResult | null; error?: string }>;
  halted: boolean;
  /**
   * Set when the template-level deploy refused to run (e.g. zero deployments
   * attached). When present, callers MUST treat the rollout as a failure.
   */
  error?: string;
}

export async function deployServiceTemplate(
  serviceId: string,
  triggeredBy: string,
  userId: string | null,
  options: DeployServiceTemplateOptions = {}
): Promise<DeployServiceTemplateResult> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: { serviceDeployments: { select: { id: true } } },
  });

  // Zero-deployment templates are a user-error state: deploying a template with
  // no servers attached silently "succeeds" otherwise, which CI/release
  // automation interprets as a green rollout.
  if (service.serviceDeployments.length === 0) {
    return {
      results: [],
      halted: true,
      error: 'Service has no deployments — add at least one server before deploying',
    };
  }

  const strategy: 'sequential' | 'parallel' =
    options.strategy ?? (service.deployStrategy as 'sequential' | 'parallel');

  // Capture the template's pre-rollout tag ONCE so every fan-out Deployment row
  // records the same previousTag. deployService updates Service.imageTag mid-flight,
  // so re-reading it per iteration would yield the new tag for later deployments.
  const originalTag = service.imageTag;
  const perDeployOptions: DeployOptions = {
    ...options,
    previousTagOverride: originalTag,
  };

  const results: DeployServiceTemplateResult['results'] = [];
  let halted = false;

  if (strategy === 'parallel') {
    const settled = await Promise.allSettled(
      service.serviceDeployments.map((sd) =>
        deployService(sd.id, triggeredBy, userId, perDeployOptions).then(
          (result) => ({ serviceDeploymentId: sd.id, result }),
          (err) => ({ serviceDeploymentId: sd.id, result: null, error: err instanceof Error ? err.message : String(err) })
        )
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ serviceDeploymentId: 'unknown', result: null, error: String(r.reason) });
      }
    }
  } else {
    for (const sd of service.serviceDeployments) {
      try {
        const result = await deployService(sd.id, triggeredBy, userId, perDeployOptions);
        results.push({ serviceDeploymentId: sd.id, result });
        if (result.deployment.status !== DEPLOYMENT_STATUS.SUCCESS) {
          // Sequential strategy halts on first failure with a clear rollback hint
          // emitted in the deployment logs (see deployService failure branch).
          halted = true;
          break;
        }
      } catch (err) {
        results.push({
          serviceDeploymentId: sd.id,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        });
        halted = true;
        break;
      }
    }
  }

  return { results, halted };
}

export type DeploymentHistoryEntry = Deployment & {
  serviceDeployment: { server: { id: string; name: string } | null } | null;
};

export async function getDeploymentHistory(
  serviceId: string,
  limit: number = 20
): Promise<DeploymentHistoryEntry[]> {
  return prisma.deployment.findMany({
    where: { serviceId },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      serviceDeployment: { select: { server: { select: { id: true, name: true } } } },
    },
  });
}

export async function getDeployment(deploymentId: string): Promise<Deployment | null> {
  return prisma.deployment.findUnique({
    where: { id: deploymentId },
  });
}

export async function getContainerLogs(
  serviceDeploymentId: string,
  options: { tail?: number; until?: string; timestamps?: boolean } = {}
): Promise<string> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: { server: true },
  });

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
    throw new Error(clientError || 'Failed to create Docker client');
  }

  try {
    if (needsConnect && sshClient) {
      await sshClient.connect();
    }
    return await dockerClient.getContainerLogs(deployment.containerName, {
      tail: options.tail ?? 100,
      until: options.until,
      timestamps: options.timestamps,
    });
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
