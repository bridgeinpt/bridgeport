import { prisma } from '../lib/db.js';
import { createHash } from 'crypto';
import YAML from 'yaml';
import { resolveSecretPlaceholders } from './secrets.js';

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

/**
 * Generate all deployment artifacts for a service
 */
export async function generateDeploymentArtifacts(
  serviceId: string
): Promise<GeneratedArtifacts> {
  const service = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: {
      server: {
        include: { environment: true },
      },
      files: {
        include: { configFile: true },
      },
    },
  });

  const environmentId = service.server.environmentId;
  const artifacts: GeneratedArtifacts = {
    compose: { name: '', content: '', checksum: '' },
    configFiles: [],
  };

  // Load config files and resolve secret placeholders (skip for binary files)
  for (const sf of service.files) {
    const isBinary = sf.configFile.isBinary;
    let content: string;

    if (isBinary) {
      // Binary files: pass through content as-is (already base64-encoded)
      content = sf.configFile.content;
    } else {
      // Text files: resolve secret placeholders and trim trailing empty lines
      const { content: resolvedContent } = await resolveSecretPlaceholders(
        environmentId,
        sf.configFile.content
      );
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

  if (service.composeTemplate) {
    // Use custom compose template with variable substitution
    composeContent = service.composeTemplate;

    // Substitute variables
    const vars: Record<string, string> = {
      SERVICE_NAME: service.name,
      CONTAINER_NAME: service.containerName,
      IMAGE_NAME: service.imageName,
      IMAGE_TAG: service.imageTag,
      FULL_IMAGE: `${service.imageName}:${service.imageTag}`,
    };

    // Add config file mount paths
    artifacts.configFiles.forEach((cf, i) => {
      vars[`CONFIG_FILE_${i}`] = cf.mountPath;
      vars[`CONFIG_FILE_${i}_NAME`] = cf.name;
    });

    for (const [key, value] of Object.entries(vars)) {
      composeContent = composeContent.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
  } else {
    // Generate default compose structure
    const composeConfig: ComposeConfig = {
      services: {
        [service.name]: {
          image: `${service.imageName}:${service.imageTag}`,
          container_name: service.containerName,
          restart: 'unless-stopped',
        },
      },
    };

    const svc = composeConfig.services[service.name];

    // Add volume mounts for config files (use absolute paths since files are written to their target paths)
    if (artifacts.configFiles.length > 0) {
      svc.volumes = artifacts.configFiles.map(
        (cf) => `${cf.mountPath}:${cf.mountPath}:ro`
      );
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
export async function previewDeploymentArtifacts(serviceId: string) {
  return generateDeploymentArtifacts(serviceId);
}
