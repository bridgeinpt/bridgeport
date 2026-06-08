import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { shellEscape, createClientForServer, type CommandClient } from '../lib/ssh.js';
import { createDockerClientForServer, type DockerClient } from '../lib/docker.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { getSecretsForEnv, resolveSecretPlaceholders } from './secrets.js';
import { redactSecretValues } from '../lib/dry-run.js';
import { composeFragmentedContent } from '../lib/config-fragments.js';
import { generateDeploymentArtifacts, serializeExposedPorts } from './compose.js';
import { safeJsonParse, getErrorMessage } from '../lib/helpers.js';
import { CONTAINER_STATUS } from '../lib/constants.js';

/**
 * Read-only drift detection: diff BRIDGEPORT's stored view of a service against
 * the actual state on the host. NEVER mutates host state — only `docker inspect`
 * and `cat` (file reads) are issued.
 *
 * SECURITY: rendered compose/config content and resolved env values can embed
 * decrypted secrets. This module NEVER returns that raw content. Content drift
 * is reported as a boolean `match` (computed over secret-redacted checksums) plus
 * a short reason; env drift reports only KEY NAMES, never values.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A field whose expected/actual scalar values can be safely echoed (no secrets). */
export interface ScalarDrift<T> {
  expected: T;
  actual: T;
  /** `null` when the comparison cannot be reliably resolved (see `reason`). */
  match: boolean | null;
  reason?: string;
}

/** Compose content drift — compared by checksum only (content may embed secrets). */
export interface ContentDrift {
  match: boolean | null;
  reason?: string;
}

export interface PortMapping {
  host: number | null;
  container: number;
  protocol?: string;
}

export interface PortsDrift {
  expected: PortMapping[];
  actual: PortMapping[];
  match: boolean | null;
  reason?: string;
}

export interface ConfigFileDrift {
  targetPath: string;
  configFileName: string;
  match: boolean | null;
  reason?: string;
}

/** Env var drift — KEY NAMES only, never values (would leak secrets). */
export interface EnvVarsDrift {
  /** Managed keys absent on the host container. */
  missing: string[];
  /** Managed keys whose host value differs from the expected (managed) value. */
  unexpected: string[];
  match: boolean | null;
  reason?: string;
}

export interface DeploymentDrift {
  serviceDeploymentId: string;
  serverId: string;
  serverName: string;
  containerName: string;
  drift: {
    composePath: ScalarDrift<string | null>;
    composeContent: ContentDrift;
    imageDigest: ScalarDrift<string | null>;
    exposedPorts: PortsDrift;
    configFiles: ConfigFileDrift[];
    envVars: EnvVarsDrift;
  };
  /** Per-deployment summary, e.g. "2 drift items detected". */
  summary: string;
  /** Non-fatal issues (host unreachable, etc.). */
  warnings: string[];
}

export interface ServiceDrift {
  serviceId: string;
  serviceName: string;
  checkedAt: string;
  deployments: DeploymentDrift[];
  summary: string;
}

export interface ServerDrift {
  serverId: string;
  serverName: string;
  checkedAt: string;
  deployments: DeploymentDrift[];
  summary: string;
}

export interface EnvironmentDrift {
  environmentId: string;
  checkedAt: string;
  services: Array<{
    serviceId: string;
    serviceName: string;
    deployments: DeploymentDrift[];
  }>;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize a port mapping list into a stable, comparable set of strings.
 * Defaults the protocol to `tcp` (Docker's default) so a stored mapping without
 * an explicit protocol compares equal to a host mapping that reports `tcp`.
 */
function portKeySet(ports: PortMapping[]): Set<string> {
  return new Set(
    ports.map((p) => `${p.host ?? 'null'}:${p.container}/${(p.protocol || 'tcp').toLowerCase()}`)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Parse a docker-compose `ports:` string entry (as produced by
 * serializeExposedPorts) back into a {host, container, protocol} mapping for
 * comparison against host-discovered ports.
 *
 * Handles `host:container`, `host:container/proto`, `ip:host:container`, and
 * `[ipv6]:host:container` forms. Returns null for anything unparseable.
 */
function parseComposePortString(entry: string): PortMapping | null {
  let protocol = 'tcp';
  let rest = entry;
  const slash = rest.lastIndexOf('/');
  if (slash !== -1) {
    protocol = rest.slice(slash + 1).toLowerCase() || 'tcp';
    rest = rest.slice(0, slash);
  }

  // Strip a leading bracketed IPv6 host-ip prefix if present.
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']:');
    if (close !== -1) rest = rest.slice(close + 2);
  }

  const parts = rest.split(':');
  // Take the last two numeric segments as host:container (an IPv4 host-ip prefix
  // contributes an earlier segment we don't compare on).
  if (parts.length < 2) return null;
  const containerStr = parts[parts.length - 1];
  const hostStr = parts[parts.length - 2];
  const container = parseInt(containerStr, 10);
  const host = parseInt(hostStr, 10);
  if (Number.isNaN(container)) return null;
  return { host: Number.isNaN(host) ? null : host, container, protocol };
}

/**
 * Expected exposed ports for a deployment. The deploy path derives `ports:`
 * from the stored `exposedPorts` via serializeExposedPorts; mirror that so the
 * expected set matches what a real deploy would publish.
 */
function expectedPortsFor(exposedPortsJson: string | null | undefined): PortMapping[] {
  const serialized = serializeExposedPorts(exposedPortsJson);
  const result: PortMapping[] = [];
  for (const s of serialized) {
    const parsed = parseComposePortString(s);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** Count fields whose match is strictly `false` (null = unresolved, not drift). */
function countDriftItems(drift: DeploymentDrift['drift']): number {
  let count = 0;
  if (drift.composePath.match === false) count++;
  if (drift.composeContent.match === false) count++;
  if (drift.imageDigest.match === false) count++;
  if (drift.exposedPorts.match === false) count++;
  if (drift.envVars.match === false) count++;
  count += drift.configFiles.filter((c) => c.match === false).length;
  return count;
}

function pluralizeDrift(count: number): string {
  return count === 1 ? '1 drift item detected' : `${count} drift items detected`;
}

// ---------------------------------------------------------------------------
// Core per-deployment drift
// ---------------------------------------------------------------------------

// Prisma include shared by all callers: a deployment with everything needed to
// regenerate expected artifacts and read host state.
const deploymentInclude = Prisma.validator<Prisma.ServiceDeploymentInclude>()({
  server: true,
  imageDigest: true,
  service: {
    include: {
      containerImage: true,
      files: {
        include: {
          configFile: {
            include: {
              includedFragments: {
                include: { fragment: true },
                orderBy: { position: 'asc' },
              },
            },
          },
        },
      },
    },
  },
});

type DeploymentWithRelations = Prisma.ServiceDeploymentGetPayload<{
  include: typeof deploymentInclude;
}>;

/**
 * Compute drift for a single ServiceDeployment. Opens one read-only client to
 * the host (Docker inspect + file reads), compares against stored/regenerated
 * state, and always disconnects. Host-unreachable conditions degrade to
 * `match: null` + a warning rather than throwing.
 */
async function computeDeploymentDrift(
  deployment: DeploymentWithRelations
): Promise<DeploymentDrift> {
  const service = deployment.service;
  const server = deployment.server;
  const environmentId = server.environmentId;
  const containerName = deployment.containerName;
  const warnings: string[] = [];

  // Pull secret values once so we can redact them out of every content
  // comparison and never compute a checksum over a leaked secret.
  const secretValues = Object.values(await getSecretsForEnv(environmentId));

  // --- composePath: stored value is the source of truth ---
  const storedComposePath = deployment.composePath;
  const composePathDrift: ScalarDrift<string | null> = storedComposePath
    ? { expected: storedComposePath, actual: storedComposePath, match: true }
    : {
        expected: null,
        actual: null,
        match: null,
        reason:
          'No compose path is set for this deployment (auto-managed compose is off or it was never deployed via compose); nothing to compare.',
      };

  // --- expected artifacts (compose + config files), regenerated like a deploy ---
  // generateDeploymentArtifacts renders secret-bearing content; we only ever
  // derive redacted checksums from it.
  let expectedComposeContent: string | null = null;
  let expectedConfigFiles: Array<{ name: string; mountPath: string; content: string; isBinary: boolean }> = [];
  try {
    const artifacts = await generateDeploymentArtifacts(deployment.id);
    expectedComposeContent = artifacts.compose.content;
    expectedConfigFiles = artifacts.configFiles;
  } catch (err) {
    warnings.push(`Could not regenerate expected artifacts: ${getErrorMessage(err, 'unknown error')}`);
  }

  // --- expected image digest: the digest BRIDGEPORT recorded as deployed ---
  const expectedManifestDigest = deployment.imageDigest?.manifestDigest ?? null;

  // --- expected exposed ports (from stored discovery) ---
  const expectedPorts = expectedPortsFor(deployment.exposedPorts);

  // --- expected managed env (baseEnv + per-deployment overrides) ---
  const baseEnv = safeJsonParse<Record<string, string>>(service.baseEnv, {});
  const envOverrides = safeJsonParse<Record<string, string>>(deployment.envOverrides, {});
  const managedEnv: Record<string, string> = { ...baseEnv, ...envOverrides };

  // Defaults: when the host is unreachable these stay as `match: null`.
  let composeContentDrift: ContentDrift = {
    match: null,
    reason: 'Host not reached; compose content not compared.',
  };
  let imageDigestDrift: ScalarDrift<string | null> = {
    expected: expectedManifestDigest,
    actual: null,
    match: null,
    reason: 'Host not reached; image digest not compared.',
  };
  let portsDrift: PortsDrift = {
    expected: expectedPorts,
    actual: [],
    match: null,
    reason: 'Host not reached; ports not compared.',
  };
  let envVarsDrift: EnvVarsDrift = {
    missing: [],
    unexpected: [],
    match: null,
    reason: 'Host not reached; env vars not compared.',
  };
  const configFilesDrift: ConfigFileDrift[] = [];

  // --- detect shared operator-maintained compose file (intentionally not rewritten) ---
  let sharedOperatorComposeFile = false;
  if (storedComposePath) {
    const siblingCount = await prisma.serviceDeployment.count({
      where: { serverId: deployment.serverId, composePath: storedComposePath },
    });
    sharedOperatorComposeFile = siblingCount > 1;
  }

  // --- read host state over a single read-only client ---
  const { dockerClient, sshClient, error: clientError, needsConnect } =
    await createDockerClientForServer(
      {
        hostname: server.hostname,
        dockerMode: server.dockerMode,
        serverType: server.serverType,
        environmentId,
      },
      getEnvironmentSshKey
    );

  // For file reads we need a command client. In socket mode the docker factory
  // also returns an SSH client (may be a LocalClient) for file ops; reuse it.
  let fileClient: CommandClient | null = sshClient;
  let fileClientOwned = false;
  if (!fileClient) {
    const fileResult = await createClientForServer(
      server.hostname,
      environmentId,
      getEnvironmentSshKey,
      { serverType: server.serverType }
    );
    fileClient = fileResult.client;
    fileClientOwned = true;
  }

  try {
    if (dockerClient && needsConnect && sshClient) {
      await sshClient.connect();
    }
    if (fileClientOwned && fileClient) {
      await fileClient.connect();
    }

    // ---- image digest drift ----
    if (!dockerClient) {
      imageDigestDrift = {
        expected: expectedManifestDigest,
        actual: null,
        match: null,
        reason: clientError || 'Could not connect to host to inspect image.',
      };
    } else {
      try {
        const digests = await dockerClient.getContainerImageDigests(containerName);
        if (!digests.found) {
          imageDigestDrift = {
            expected: expectedManifestDigest,
            actual: null,
            match: false,
            reason: 'Container not found on host.',
          };
        } else if (!expectedManifestDigest) {
          imageDigestDrift = {
            expected: null,
            actual: digests.repoDigests[0] ?? null,
            match: null,
            reason:
              'BRIDGEPORT has no recorded deployed digest for this deployment; cannot compare.',
          };
        } else if (digests.repoDigests.length === 0) {
          // Locally-built or pre-pull images have no RepoDigests; the local
          // RepoDigests vs registry manifest digest comparison is not reliably
          // resolvable here (mirrors deploy.ts's mode-specific caveat).
          imageDigestDrift = {
            expected: expectedManifestDigest,
            actual: null,
            match: null,
            reason:
              'Host image has no registry digest (locally built or never pulled by digest); cannot compare reliably.',
          };
        } else {
          // RepoDigests look like "repo@sha256:..."; match the expected manifest
          // digest against the sha portion of any of them.
          const hostShas = digests.repoDigests.map((d) => {
            const at = d.lastIndexOf('@');
            return at === -1 ? d : d.slice(at + 1);
          });
          const matched = hostShas.includes(expectedManifestDigest);
          imageDigestDrift = {
            expected: expectedManifestDigest,
            actual: hostShas[0] ?? null,
            match: matched,
            ...(matched
              ? {}
              : { reason: 'Host image digest does not match the recorded deployed digest.' }),
          };
        }
      } catch (err) {
        imageDigestDrift = {
          expected: expectedManifestDigest,
          actual: null,
          match: null,
          reason: `Could not inspect image digest: ${getErrorMessage(err, 'unknown error')}`,
        };
      }
    }

    // ---- exposed ports drift ----
    if (!dockerClient) {
      portsDrift = {
        expected: expectedPorts,
        actual: [],
        match: null,
        reason: clientError || 'Could not connect to host to inspect ports.',
      };
    } else {
      try {
        const info = await dockerClient.getContainerInfo(containerName);
        if (info.state === CONTAINER_STATUS.NOT_FOUND) {
          portsDrift = {
            expected: expectedPorts,
            actual: [],
            match: false,
            reason: 'Container not found on host.',
          };
        } else {
          const actualPorts: PortMapping[] = info.ports.map((p) => ({
            host: p.host,
            container: p.container,
            protocol: p.protocol,
          }));
          const match = setsEqual(portKeySet(expectedPorts), portKeySet(actualPorts));
          portsDrift = {
            expected: expectedPorts,
            actual: actualPorts,
            match,
            ...(match ? {} : { reason: 'Published ports differ from the stored mapping.' }),
          };
        }
      } catch (err) {
        portsDrift = {
          expected: expectedPorts,
          actual: [],
          match: null,
          reason: `Could not inspect ports: ${getErrorMessage(err, 'unknown error')}`,
        };
      }
    }

    // ---- env vars drift (managed keys only; never echo values) ----
    if (!dockerClient) {
      envVarsDrift = {
        missing: [],
        unexpected: [],
        match: null,
        reason: clientError || 'Could not connect to host to inspect env.',
      };
    } else {
      try {
        const hostEnv = await dockerClient.getContainerEnv(containerName);
        if (hostEnv === null) {
          envVarsDrift = {
            missing: [],
            unexpected: [],
            match: false,
            reason: 'Container not found on host.',
          };
        } else {
          const missing: string[] = [];
          const unexpected: string[] = [];
          // Only compare keys BRIDGEPORT manages. Image-baked / Docker-injected
          // vars (PATH, HOSTNAME, …) are intentionally ignored.
          for (const [key, expectedValue] of Object.entries(managedEnv)) {
            if (!(key in hostEnv)) {
              missing.push(key);
            } else if (hostEnv[key] !== expectedValue) {
              // Value differs — report the KEY only; never the secret value.
              unexpected.push(key);
            }
          }
          const match = missing.length === 0 && unexpected.length === 0;
          envVarsDrift = { missing, unexpected, match };
        }
      } catch (err) {
        envVarsDrift = {
          missing: [],
          unexpected: [],
          match: null,
          reason: `Could not inspect env: ${getErrorMessage(err, 'unknown error')}`,
        };
      }
    }

    // ---- compose content drift (checksum over redacted content) ----
    if (!storedComposePath) {
      composeContentDrift = {
        match: null,
        reason: 'No compose path set; compose content not compared.',
      };
    } else if (sharedOperatorComposeFile) {
      composeContentDrift = {
        match: null,
        reason:
          'Compose file is shared by multiple deployments and operator-maintained; BRIDGEPORT does not rewrite it, so content drift is expected and not flagged.',
      };
    } else if (expectedComposeContent === null) {
      composeContentDrift = {
        match: null,
        reason: 'Expected compose content unavailable (artifact regeneration failed).',
      };
    } else if (!fileClient) {
      composeContentDrift = {
        match: null,
        reason: clientError || 'Could not connect to host to read compose file.',
      };
    } else {
      try {
        // shellEscape: composePath is operator/user-supplied. Read-only cat.
        const { stdout, code } = await fileClient.exec(
          `cat ${shellEscape(storedComposePath)} 2>/dev/null`
        );
        if (code !== 0) {
          composeContentDrift = { match: false, reason: 'Compose file not found on host.' };
        } else {
          const hostRedacted = redactSecretValues(stdout.replace(/\n$/, ''), secretValues);
          const expectedRedacted = redactSecretValues(
            expectedComposeContent.replace(/\n$/, ''),
            secretValues
          );
          const match = checksum(hostRedacted) === checksum(expectedRedacted);
          composeContentDrift = {
            match,
            ...(match
              ? {}
              : { reason: 'Host compose file content differs from the regenerated compose.' }),
          };
        }
      } catch (err) {
        composeContentDrift = {
          match: null,
          reason: `Could not read compose file: ${getErrorMessage(err, 'unknown error')}`,
        };
      }
    }

    // ---- config files drift (checksum over redacted content per file) ----
    // Build expected rendered content per target path from regenerated artifacts.
    const expectedByPath = new Map(expectedConfigFiles.map((cf) => [cf.mountPath, cf]));

    // Resolve which ConfigFiles apply to this deployment (override beats base),
    // matching generateDeploymentArtifacts' selection.
    const filesByConfigId = new Map<string, typeof service.files[number]>();
    for (const sf of service.files) {
      if (sf.serviceDeploymentId === deployment.id) {
        filesByConfigId.set(sf.configFileId, sf);
      } else if (sf.serviceDeploymentId === null && !filesByConfigId.has(sf.configFileId)) {
        filesByConfigId.set(sf.configFileId, sf);
      }
    }

    for (const sf of filesByConfigId.values()) {
      const targetPath = sf.targetPath;
      const configFileName = sf.configFile.name;

      if (sf.configFile.isBinary) {
        configFilesDrift.push({
          targetPath,
          configFileName,
          match: null,
          reason: 'Binary file; content drift not compared.',
        });
        continue;
      }

      if (!fileClient) {
        configFilesDrift.push({
          targetPath,
          configFileName,
          match: null,
          reason: clientError || 'Could not connect to host to read config file.',
        });
        continue;
      }

      // Render expected content (redacted). Prefer the regenerated artifact;
      // fall back to rendering directly if artifact generation failed.
      let expectedRendered: string | null = null;
      const fromArtifact = expectedByPath.get(targetPath);
      if (fromArtifact && !fromArtifact.isBinary) {
        expectedRendered = redactSecretValues(fromArtifact.content.replace(/\n$/, ''), secretValues);
      } else {
        try {
          const composedSource = composeFragmentedContent(
            sf.configFile.includedFragments.map((f) => ({
              name: f.fragment.name,
              content: f.fragment.content,
            })),
            sf.configFile.content,
            sf.configFile.language
          );
          const { content: resolved, templateErrors } = await resolveSecretPlaceholders(
            environmentId,
            composedSource
          );
          if (templateErrors.length > 0) {
            configFilesDrift.push({
              targetPath,
              configFileName,
              match: null,
              reason: `Template errors prevent comparison: ${templateErrors.join('; ')}`,
            });
            continue;
          }
          expectedRendered = redactSecretValues(resolved.replace(/\n$/, ''), secretValues);
        } catch (err) {
          configFilesDrift.push({
            targetPath,
            configFileName,
            match: null,
            reason: `Could not render expected content: ${getErrorMessage(err, 'unknown error')}`,
          });
          continue;
        }
      }

      try {
        // shellEscape: targetPath is user-supplied. Read-only cat.
        const { stdout, code } = await fileClient.exec(
          `cat ${shellEscape(targetPath)} 2>/dev/null`
        );
        if (code !== 0) {
          configFilesDrift.push({
            targetPath,
            configFileName,
            match: false,
            reason: 'Config file not found on host.',
          });
          continue;
        }
        const hostRedacted = redactSecretValues(stdout.replace(/\n$/, ''), secretValues);
        const match = checksum(hostRedacted) === checksum(expectedRendered ?? '');
        configFilesDrift.push({
          targetPath,
          configFileName,
          match,
          ...(match ? {} : { reason: 'Host file content differs from the rendered config.' }),
        });
      } catch (err) {
        configFilesDrift.push({
          targetPath,
          configFileName,
          match: null,
          reason: `Could not read host file: ${getErrorMessage(err, 'unknown error')}`,
        });
      }
    }
  } catch (err) {
    warnings.push(`Host inspection failed: ${getErrorMessage(err, 'unknown error')}`);
  } finally {
    if (sshClient) {
      try { sshClient.disconnect(); } catch { /* ignore */ }
    }
    if (fileClientOwned && fileClient) {
      try { fileClient.disconnect(); } catch { /* ignore */ }
    }
  }

  const drift: DeploymentDrift['drift'] = {
    composePath: composePathDrift,
    composeContent: composeContentDrift,
    imageDigest: imageDigestDrift,
    exposedPorts: portsDrift,
    configFiles: configFilesDrift,
    envVars: envVarsDrift,
  };

  return {
    serviceDeploymentId: deployment.id,
    serverId: server.id,
    serverName: server.name,
    containerName,
    drift,
    summary: pluralizeDrift(countDriftItems(drift)),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Public roll-ups
// ---------------------------------------------------------------------------

/**
 * Compute drift for a Service template across all of its ServiceDeployments
 * (one per server). Results are keyed by serverId via DeploymentDrift.serverId.
 */
export async function computeServiceDrift(serviceId: string): Promise<ServiceDrift | null> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { id: true, name: true },
  });
  if (!service) return null;

  const deployments = await prisma.serviceDeployment.findMany({
    where: { serviceId },
    include: deploymentInclude,
    orderBy: { server: { name: 'asc' } },
  });

  const results = await Promise.all(deployments.map((d) => computeDeploymentDrift(d)));
  const total = results.reduce((sum, r) => sum + countDriftItems(r.drift), 0);

  return {
    serviceId: service.id,
    serviceName: service.name,
    checkedAt: new Date().toISOString(),
    deployments: results,
    summary: pluralizeDrift(total),
  };
}

/**
 * Compute drift for every deployment on a server.
 */
export async function computeServerDrift(serverId: string): Promise<ServerDrift | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, name: true },
  });
  if (!server) return null;

  const deployments = await prisma.serviceDeployment.findMany({
    where: { serverId },
    include: deploymentInclude,
    orderBy: { service: { name: 'asc' } },
  });

  const results = await Promise.all(deployments.map((d) => computeDeploymentDrift(d)));
  const total = results.reduce((sum, r) => sum + countDriftItems(r.drift), 0);

  return {
    serverId: server.id,
    serverName: server.name,
    checkedAt: new Date().toISOString(),
    deployments: results,
    summary: pluralizeDrift(total),
  };
}

/**
 * Environment-wide drift roll-up: every deployment of every service in the env,
 * grouped by service.
 */
export async function computeEnvironmentDrift(
  environmentId: string
): Promise<EnvironmentDrift | null> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true },
  });
  if (!environment) return null;

  const deployments = await prisma.serviceDeployment.findMany({
    where: { server: { environmentId } },
    include: deploymentInclude,
    orderBy: [{ service: { name: 'asc' } }, { server: { name: 'asc' } }],
  });

  const results = await Promise.all(deployments.map((d) => computeDeploymentDrift(d)));

  // Group results back by service.
  const byService = new Map<
    string,
    { serviceId: string; serviceName: string; deployments: DeploymentDrift[] }
  >();
  for (let i = 0; i < deployments.length; i++) {
    const dep = deployments[i];
    const entry = byService.get(dep.serviceId) ?? {
      serviceId: dep.serviceId,
      serviceName: dep.service.name,
      deployments: [],
    };
    entry.deployments.push(results[i]);
    byService.set(dep.serviceId, entry);
  }

  const total = results.reduce((sum, r) => sum + countDriftItems(r.drift), 0);

  return {
    environmentId: environment.id,
    checkedAt: new Date().toISOString(),
    services: Array.from(byService.values()),
    summary: pluralizeDrift(total),
  };
}
