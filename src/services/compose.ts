import { prisma } from '../lib/db.js';
import { createHash } from 'crypto';
import YAML from 'yaml';
import { resolveSecretPlaceholders, getSecretsForEnv } from './secrets.js';
import { safeJsonParse, getErrorMessage } from '../lib/helpers.js';
import { redactEnvSecrets, redactSecretValues } from '../lib/dry-run.js';
import { composeFragmentedContent } from '../lib/config-fragments.js';

export interface ComposeConfig {
  version?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

export interface ComposeService {
  image?: string;
  container_name?: string;
  environment?: string[] | Record<string, string>;
  env_file?: string | string[];
  volumes?: string[];
  ports?: string[];
  networks?: string[];
  depends_on?: string[];
  restart?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface GeneratedArtifacts {
  compose: { name: string; content: string; checksum: string };
  configFiles: Array<{ name: string; content: string; checksum: string; mountPath: string; isBinary: boolean }>;
}

function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ExposedPort {
  host: number | null;
  container: number;
  protocol?: string;
  hostIp?: string | null;
}

const VALID_PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);

function isWildcardHostIp(hostIp: string | null | undefined): boolean {
  if (!hostIp) return true;
  return hostIp === '0.0.0.0' || hostIp === '::';
}

function formatHostIpPrefix(hostIp: string | null | undefined): string {
  if (isWildcardHostIp(hostIp)) return '';
  // IPv6 addresses contain colons and must be bracketed in the compose port
  // format (e.g., `[::1]:8080:80`).
  return hostIp!.includes(':') ? `[${hostIp}]:` : `${hostIp}:`;
}

/**
 * Convert a service's stored `exposedPorts` JSON (as discovered from a running
 * container) into docker-compose `ports:` string entries.
 *
 * Behavior:
 * - Explicit `{host, container}` → `"host:container"`.
 * - `host: null` (container only `EXPOSE`s the port, no `-p`) → default the
 *   host side to the container port (`"container:container"`) so the
 *   regenerated compose still publishes it. Without this, Docker silently
 *   starts the container with no host binding and the service becomes
 *   unreachable from outside the docker bridge network (issue #117).
 * - `hostIp` is preserved end-to-end. A binding originally created with
 *   `127.0.0.1:8080:80` round-trips as `"127.0.0.1:8080:80"` rather than
 *   silently widening to `0.0.0.0:8080` on regenerate.
 * - Wildcard host IPs (`0.0.0.0`, `::`, empty) are emitted without a prefix
 *   so docker-compose binds on all interfaces (its default).
 *
 * Duplicate entries (Docker reports the same mapping once per host IP family,
 * e.g., IPv4 + IPv6) collapse to one.
 */
export function serializeExposedPorts(exposedPortsJson: string | null | undefined): string[] {
  const parsed = safeJsonParse<unknown>(exposedPortsJson, []);
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<ExposedPort>;

    if (typeof entry.container !== 'number') continue;
    const container = entry.container;
    if (!Number.isInteger(container) || container <= 0 || container > 65535) continue;

    let host: number;
    if (entry.host === null || entry.host === undefined) {
      host = container;
    } else {
      if (typeof entry.host !== 'number') continue;
      if (!Number.isInteger(entry.host) || entry.host <= 0 || entry.host > 65535) continue;
      host = entry.host;
    }

    const rawProtocol = typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : 'tcp';
    const protocol = VALID_PROTOCOLS.has(rawProtocol) ? rawProtocol : 'tcp';
    const suffix = protocol === 'tcp' ? '' : `/${protocol}`;

    const hostIp = typeof entry.hostIp === 'string' ? entry.hostIp : null;
    const prefix = formatHostIpPrefix(hostIp);

    const portString = `${prefix}${host}:${container}${suffix}`;

    if (seen.has(portString)) continue;
    seen.add(portString);
    result.push(portString);
  }

  return result;
}

/**
 * Validate that a compose file actually defines a service keyed on the
 * deployment's `containerName`. The deploy path runs `docker compose pull/up
 * <containerName>`, so the compose document MUST contain a top-level service
 * with that exact key — otherwise compose aborts with "No such service:
 * <containerName>" BEFORE recreating anything, leaving the stale container in
 * place (the stale-config trap in issue #200).
 *
 * Works for both generator-authored and template-authored compose: it parses
 * the actual YAML rather than assuming the generator's structure, and tolerates
 * shared compose files that define multiple services (it only requires that the
 * deployment's OWN service key is present among them).
 *
 * Returns an error message string when invalid, or `null` when valid.
 */
export function validateGeneratedCompose(
  composeContent: string,
  containerName: string
): string | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(composeContent);
  } catch (err) {
    return `Generated compose for "${containerName}" is not valid YAML: ${getErrorMessage(err)}`;
  }

  if (parsed === null || typeof parsed !== 'object') {
    return `Generated compose for "${containerName}" did not parse to a compose document`;
  }

  const services = (parsed as { services?: unknown }).services;
  if (services === null || typeof services !== 'object') {
    return `Generated compose for "${containerName}" has no "services:" section`;
  }

  const serviceKeys = Object.keys(services as Record<string, unknown>);
  if (!serviceKeys.includes(containerName)) {
    return (
      `Compose service key mismatch: deploy targets "${containerName}" but the ` +
      `compose file defines service(s) [${serviceKeys.join(', ') || 'none'}]. ` +
      `The compose file must contain a service keyed exactly on "${containerName}". ` +
      `If you maintain this compose file by hand, rename the service to "${containerName}".`
    );
  }

  return null;
}

/**
 * Generate all deployment artifacts for a ServiceDeployment.
 * Resolves per-deployment env overrides on top of the Service template's baseEnv,
 * and per-deployment override files on top of the template's base files.
 */
export async function generateDeploymentArtifacts(
  serviceDeploymentId: string
): Promise<GeneratedArtifacts> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: {
      server: { include: { environment: true } },
      service: {
        include: {
          files: {
            include: {
              configFile: {
                include: {
                  // Ordered fragment includes — concatenated before the
                  // ConfigFile's own content at render time. orderBy is
                  // critical: ordering controls last-definition-wins on
                  // duplicate keys.
                  includedFragments: {
                    include: { fragment: true },
                    orderBy: { position: 'asc' },
                  },
                },
              },
            },
          },
          containerImage: true,
        },
      },
    },
  });

  const service = deployment.service;
  const environmentId = deployment.server.environmentId;
  const artifacts: GeneratedArtifacts = {
    compose: { name: '', content: '', checksum: '' },
    configFiles: [],
  };

  // Pick the ServiceFile for each ConfigFile: prefer per-deployment override
  // (serviceDeploymentId match) over the template base (serviceDeploymentId null).
  const filesByConfigId = new Map<string, typeof service.files[number]>();
  for (const sf of service.files) {
    if (sf.serviceDeploymentId === deployment.id) {
      filesByConfigId.set(sf.configFileId, sf);
    } else if (sf.serviceDeploymentId === null && !filesByConfigId.has(sf.configFileId)) {
      filesByConfigId.set(sf.configFileId, sf);
    }
  }

  // Load config files and resolve secret placeholders (skip for binary files)
  for (const sf of filesByConfigId.values()) {
    const isBinary = sf.configFile.isBinary;
    let content: string;

    if (isBinary) {
      // Binary files: pass through content as-is (already base64-encoded)
      content = sf.configFile.content;
    } else {
      // Text files: resolve secret placeholders and trim trailing empty lines.
      // templateErrors indicate the template syntax itself is broken (malformed
      // {{range}}, unknown filter, etc); the rendered content would ship with
      // raw directive text or empty bodies and is unsafe to deploy — fail loudly.
      // Compose fragments + own content first so placeholder substitution runs
      // over the merged blob (fragments share the same `${KEY}` semantics).
      const composedSource = composeFragmentedContent(
        sf.configFile.includedFragments.map((f) => ({
          name: f.fragment.name,
          content: f.fragment.content,
        })),
        sf.configFile.content,
        sf.configFile.language,
      );
      const { content: resolvedContent, templateErrors } = await resolveSecretPlaceholders(
        environmentId,
        composedSource
      );
      if (templateErrors.length > 0) {
        throw new Error(
          `Config file "${sf.configFile.filename}" has template errors: ${templateErrors.join('; ')}`
        );
      }
      content = resolvedContent.trimEnd();
    }

    const checksum = createHash('sha256').update(content).digest('hex');
    artifacts.configFiles.push({
      name: sf.configFile.filename,
      content,
      checksum,
      mountPath: sf.targetPath,
      isBinary,
    });
  }

  // Generate compose file
  let composeContent: string;

  // Get imageName from containerImage
  const imageName = service.containerImage.imageName;

  // Resolve env: merge Service.baseEnv over ServiceDeployment.envOverrides (overrides win).
  const baseEnv = safeJsonParse<Record<string, string>>(service.baseEnv, {});
  const envOverrides = safeJsonParse<Record<string, string>>(deployment.envOverrides, {});
  const mergedEnv: Record<string, string> = { ...baseEnv, ...envOverrides };

  if (service.composeTemplate) {
    // Use custom compose template with variable substitution
    composeContent = service.composeTemplate;

    // Substitute variables
    const vars: Record<string, string> = {
      SERVICE_NAME: service.name,
      CONTAINER_NAME: deployment.containerName,
      IMAGE_NAME: imageName,
      IMAGE_TAG: service.imageTag,
      FULL_IMAGE: `${imageName}:${service.imageTag}`,
    };

    // Add config file mount paths
    artifacts.configFiles.forEach((cf, i) => {
      vars[`CONFIG_FILE_${i}`] = cf.mountPath;
      vars[`CONFIG_FILE_${i}_NAME`] = cf.name;
    });

    for (const [key, value] of Object.entries(vars)) {
      // Use a function replacer so `$&`, `$$`, `$1`, etc. in `value` are NOT
      // interpreted as regex backreferences in the replacement string.
      composeContent = composeContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), () => value);
    }
  } else {
    // Generate default compose structure.
    // Key the compose service on `containerName` (not `service.name`): the deploy
    // path targets the service by `containerName` in `docker compose pull/up`, so
    // the generated key MUST match or deploy aborts with "No such service". (issue #200)
    const composeConfig: ComposeConfig = {
      services: {
        [deployment.containerName]: {
          image: `${imageName}:${service.imageTag}`,
          container_name: deployment.containerName,
          restart: 'unless-stopped',
        },
      },
    };

    const svc = composeConfig.services[deployment.containerName];

    // Inject merged env vars (base + per-deployment overrides) into the compose service.
    if (Object.keys(mergedEnv).length > 0) {
      svc.environment = mergedEnv;
    }

    // Add volume mounts for config files (use absolute paths since files are written to their target paths)
    if (artifacts.configFiles.length > 0) {
      svc.volumes = artifacts.configFiles.map(
        (cf) => `${cf.mountPath}:${cf.mountPath}:ro`
      );
    }

    // Add `ports:` entries derived from the deployment's discovered exposedPorts.
    // Without this, regenerating compose for a service that previously had
    // explicit port bindings would drop them and the container would come up
    // unreachable (issue #117).
    const ports = serializeExposedPorts(deployment.exposedPorts);
    if (ports.length > 0) {
      svc.ports = ports;
    }

    composeContent = YAML.stringify(composeConfig);
  }

  artifacts.compose = {
    name: `docker-compose.${service.name}.yml`,
    content: composeContent,
    checksum: computeChecksum(composeContent),
  };

  return artifacts;
}

/**
 * Save deployment artifacts to database
 */
export async function saveDeploymentArtifacts(
  deploymentId: string,
  artifacts: GeneratedArtifacts
): Promise<void> {
  const createData = [
    {
      type: 'compose',
      name: artifacts.compose.name,
      content: artifacts.compose.content,
      checksum: artifacts.compose.checksum,
      deploymentId,
    },
  ];

  for (const cf of artifacts.configFiles) {
    createData.push({
      type: 'config',
      name: cf.name,
      content: cf.content,
      checksum: cf.checksum,
      deploymentId,
    });
  }

  await prisma.deploymentArtifact.createMany({
    data: createData,
  });
}

/**
 * Get deployment artifacts
 */
export async function getDeploymentArtifacts(deploymentId: string) {
  return prisma.deploymentArtifact.findMany({
    where: { deploymentId },
    orderBy: { type: 'asc' },
  });
}

/**
 * Preview generated artifacts without saving
 */
export async function previewDeploymentArtifacts(serviceDeploymentId: string) {
  return generateDeploymentArtifacts(serviceDeploymentId);
}

/**
 * Dry-run preview of the artifacts a real deploy would generate, with secret
 * VALUES redacted (`***`) in both the compose content and the merged env.
 *
 * Used by `POST /…/deploy?dryRun=true` and plan dry-runs. Returns warnings
 * (rather than throwing) for non-fatal issues such as missing secrets or
 * template errors — the caller renders them in the dry-run report so users
 * can fix them before triggering a real deploy.
 */
export interface DryRunArtifactsPreview {
  composeContent: string;
  env: Record<string, string>;
  configFiles: Array<{ name: string; mountPath: string; content: string; isBinary: boolean }>;
  warnings: string[];
  /**
   * `true` when the real deploy would have thrown during artifact generation
   * (template errors or missing secrets in a config file). The preview is
   * still produced so callers can render the (partial) result, but they
   * should surface this flag as a hard block instead of silently shipping a
   * compose that the live path would have rejected.
   */
  wouldFail?: boolean;
  /** Reason populated when `wouldFail === true`. */
  failureReason?: string;
}

export interface PreviewDryRunArtifactsOptions {
  /**
   * Override the image tag used in the rendered compose (mirrors
   * `DeployOptions.imageTag`). When unset, falls back to the Service template's
   * own `imageTag`. Used by plan dry-runs so each step previews the tag the
   * real `executePlan` would have used (`step.targetTag`), not the current
   * template tag.
   */
  imageTag?: string;
}

export async function previewDryRunArtifacts(
  serviceDeploymentId: string,
  options: PreviewDryRunArtifactsOptions = {}
): Promise<DryRunArtifactsPreview> {
  const deployment = await prisma.serviceDeployment.findUniqueOrThrow({
    where: { id: serviceDeploymentId },
    include: {
      server: { include: { environment: true } },
      service: {
        include: {
          files: {
            include: {
              configFile: {
                include: {
                  // Ordered fragment includes — concatenated before the
                  // ConfigFile's own content at render time. orderBy is
                  // critical: ordering controls last-definition-wins on
                  // duplicate keys.
                  includedFragments: {
                    include: { fragment: true },
                    orderBy: { position: 'asc' },
                  },
                },
              },
            },
          },
          containerImage: true,
        },
      },
    },
  });

  const service = deployment.service;
  const environmentId = deployment.server.environmentId;
  const warnings: string[] = [];
  // Track conditions that would make the real `generateDeploymentArtifacts`
  // path throw. Reported back via wouldFail/failureReason so callers can
  // mark the dry-run preview as a hard would-fail (rather than silently
  // rendering an artifact that the live path would refuse).
  const failureReasons: string[] = [];

  // Resolve image tag override (mirrors DeployOptions.imageTag in the real
  // path). Without this, plan dry-runs would preview the current Service tag
  // instead of `step.targetTag`.
  const imageTag = options.imageTag ?? service.imageTag;

  // Pull all secret VALUES once so we can redact them out of the rendered
  // compose YAML and env map. Secrets win over vars during resolution, so a
  // var that shares a key with a secret will also resolve to the secret value
  // — redacting only the secret values is therefore sufficient to scrub the
  // sensitive material from the response.
  const secretValues = Object.values(await getSecretsForEnv(environmentId));

  // Pick the ServiceFile for each ConfigFile (per-deployment override beats template base).
  const filesByConfigId = new Map<string, typeof service.files[number]>();
  for (const sf of service.files) {
    if (sf.serviceDeploymentId === deployment.id) {
      filesByConfigId.set(sf.configFileId, sf);
    } else if (sf.serviceDeploymentId === null && !filesByConfigId.has(sf.configFileId)) {
      filesByConfigId.set(sf.configFileId, sf);
    }
  }

  // Resolve config files (text only — binary content stays as base64 placeholder).
  const configFiles: DryRunArtifactsPreview['configFiles'] = [];
  for (const sf of filesByConfigId.values()) {
    if (sf.configFile.isBinary) {
      configFiles.push({
        name: sf.configFile.filename,
        mountPath: sf.targetPath,
        content: '<binary content omitted from dry-run>',
        isBinary: true,
      });
      continue;
    }
    // Compose fragments + own content before resolving placeholders. Same
    // contract as the live path — without this the dry-run would preview a
    // rendered file that differs from what a real deploy actually writes.
    const composedSource = composeFragmentedContent(
      sf.configFile.includedFragments.map((f) => ({
        name: f.fragment.name,
        content: f.fragment.content,
      })),
      sf.configFile.content,
      sf.configFile.language,
    );
    const { content: resolved, missing, templateErrors } = await resolveSecretPlaceholders(
      environmentId,
      composedSource
    );
    if (templateErrors.length > 0) {
      const msg = `Config file "${sf.configFile.filename}" template errors: ${templateErrors.join('; ')}`;
      warnings.push(msg);
      // The live path throws on template errors — surface that structurally.
      failureReasons.push(msg);
    }
    if (missing.length > 0) {
      const msg = `Config file "${sf.configFile.filename}" missing secrets: ${missing.join(', ')}`;
      warnings.push(msg);
      // The live config-file sync path treats missing secrets as a hard
      // failure (`success: false, error: 'Missing secrets: ...'`), and the
      // real artifact generation path would render the placeholder verbatim
      // into the file — either way, callers should see this as a would-fail.
      failureReasons.push(msg);
    }
    configFiles.push({
      name: sf.configFile.filename,
      mountPath: sf.targetPath,
      content: redactSecretValues(resolved.trimEnd(), secretValues),
      isBinary: false,
    });
  }

  // Resolve env: merge baseEnv with envOverrides (overrides win).
  const baseEnv = safeJsonParse<Record<string, string>>(service.baseEnv, {});
  const envOverrides = safeJsonParse<Record<string, string>>(deployment.envOverrides, {});
  const mergedEnv: Record<string, string> = { ...baseEnv, ...envOverrides };
  const redactedEnv = redactEnvSecrets(mergedEnv, secretValues);

  // Generate compose YAML using the same logic as generateDeploymentArtifacts.
  const imageName = service.containerImage.imageName;
  let composeContent: string;
  if (service.composeTemplate) {
    composeContent = service.composeTemplate;
    const vars: Record<string, string> = {
      SERVICE_NAME: service.name,
      CONTAINER_NAME: deployment.containerName,
      IMAGE_NAME: imageName,
      IMAGE_TAG: imageTag,
      FULL_IMAGE: `${imageName}:${imageTag}`,
    };
    configFiles.forEach((cf, i) => {
      vars[`CONFIG_FILE_${i}`] = cf.mountPath;
      vars[`CONFIG_FILE_${i}_NAME`] = cf.name;
    });
    for (const [key, value] of Object.entries(vars)) {
      // Function replacer avoids `$&`, `$$`, `$1` interpretation in `value`.
      composeContent = composeContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), () => value);
    }
  } else {
    // Key the service on `containerName` to match the real deploy path. (issue #200)
    const composeConfig: ComposeConfig = {
      services: {
        [deployment.containerName]: {
          image: `${imageName}:${imageTag}`,
          container_name: deployment.containerName,
          restart: 'unless-stopped',
        },
      },
    };
    const svc = composeConfig.services[deployment.containerName];
    if (Object.keys(mergedEnv).length > 0) {
      // Use redacted env in the compose YAML so secret values don't leak in
      // the response. The compose YAML's `environment:` block stays a faithful
      // representation of what the real deploy would emit, minus the secrets.
      svc.environment = redactedEnv;
    }
    if (configFiles.length > 0) {
      svc.volumes = configFiles.map((cf) => `${cf.mountPath}:${cf.mountPath}:ro`);
    }
    const ports = serializeExposedPorts(deployment.exposedPorts);
    if (ports.length > 0) {
      svc.ports = ports;
    }
    composeContent = YAML.stringify(composeConfig);
  }

  // Belt-and-suspenders: redact secret values one more time in case the
  // compose template substituted ${KEY} placeholders that resolved to a secret.
  // (The default-compose branch already uses the redacted env map, but a
  // custom composeTemplate could embed secrets via variable substitution.)
  composeContent = redactSecretValues(composeContent, secretValues);

  const wouldFail = failureReasons.length > 0;
  return {
    composeContent,
    env: redactedEnv,
    configFiles,
    warnings,
    ...(wouldFail
      ? { wouldFail: true, failureReason: failureReasons.join('; ') }
      : {}),
  };
}
