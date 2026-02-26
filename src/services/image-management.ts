import { prisma } from '../lib/db.js';
import type { ContainerImage, ContainerImageHistory, Service } from '@prisma/client';
import { RegistryFactory, type RegistryTag } from '../lib/registry.js';
import { findLatestInFamily, findCompanionTag, extractRepoName } from '../lib/image-utils.js';
import { getRegistryCredentials } from './registries.js';

export interface CreateContainerImageInput {
  name: string;
  imageName: string;
  currentTag: string;
  environmentId: string;
  registryConnectionId?: string | null;
}

export interface UpdateContainerImageInput {
  name?: string;
  currentTag?: string;
  latestTag?: string;
  latestDigest?: string;
  deployedDigest?: string | null;
  lastCheckedAt?: Date;
  registryConnectionId?: string | null;
  autoUpdate?: boolean;
}

/**
 * Create a new container image
 */
export async function createContainerImage(
  input: CreateContainerImageInput
): Promise<ContainerImage> {
  return prisma.containerImage.create({
    data: {
      name: input.name,
      imageName: input.imageName,
      currentTag: input.currentTag,
      environmentId: input.environmentId,
      registryConnectionId: input.registryConnectionId,
    },
  });
}

/**
 * Update a container image
 */
export async function updateContainerImage(
  id: string,
  input: UpdateContainerImageInput
): Promise<ContainerImage> {
  return prisma.containerImage.update({
    where: { id },
    data: input,
  });
}

/**
 * Delete a container image (will fail if services are linked due to onDelete: Restrict)
 */
export async function deleteContainerImage(id: string): Promise<void> {
  // Check if any services are linked
  const linkedServices = await prisma.service.count({
    where: { containerImageId: id },
  });

  if (linkedServices > 0) {
    throw new Error(
      `Cannot delete container image: ${linkedServices} service(s) are still linked to it. ` +
      `Please reassign or delete those services first.`
    );
  }

  await prisma.containerImage.delete({
    where: { id },
  });
}

/**
 * Get a container image with its services
 */
export async function getContainerImage(id: string): Promise<ContainerImage & { services: Service[] } | null> {
  return prisma.containerImage.findUnique({
    where: { id },
    include: {
      services: {
        include: {
          server: true,
        },
      },
      registryConnection: true,
    },
  });
}

/**
 * List container images for an environment
 */
export async function listContainerImages(
  environmentId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ images: (ContainerImage & { services: Service[] })[]; total: number }> {
  const limit = options?.limit ?? 25;
  const offset = options?.offset ?? 0;
  const where = { environmentId };

  const [images, total] = await Promise.all([
    prisma.containerImage.findMany({
      where,
      include: {
        services: {
          include: {
            server: true,
          },
        },
        registryConnection: true,
        tagHistory: {
          orderBy: { deployedAt: 'desc' },
          take: 1,
          select: { deployedAt: true },
        },
      },
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    }),
    prisma.containerImage.count({ where }),
  ]);

  return { images, total };
}

/**
 * Link a service to a container image
 * Only updates the containerImageId and syncs the imageTag
 */
export async function linkServiceToContainerImage(
  containerImageId: string,
  serviceId: string
): Promise<Service> {
  const containerImage = await prisma.containerImage.findUniqueOrThrow({
    where: { id: containerImageId },
  });

  // Update the service's containerImageId and sync imageTag
  return prisma.service.update({
    where: { id: serviceId },
    data: {
      containerImageId,
      imageTag: containerImage.currentTag,
    },
  });
}

/**
 * Record a tag deployment in history
 */
export async function recordTagDeployment(
  containerImageId: string,
  tag: string,
  digest?: string,
  deployedBy?: string,
  status: 'success' | 'failed' | 'rolled_back' = 'success'
): Promise<ContainerImageHistory> {
  // Only update the container image's current tag on success
  if (status === 'success') {
    // Resolve the deployed digest: use provided digest, or fall back to latestDigest
    // if we're deploying the same tag that was just checked
    let resolvedDigest = digest;
    if (!resolvedDigest) {
      const image = await prisma.containerImage.findUnique({
        where: { id: containerImageId },
        select: { latestTag: true, latestDigest: true },
      });
      if (image?.latestDigest && image.latestTag === tag) {
        resolvedDigest = image.latestDigest;
      }
    }

    await prisma.containerImage.update({
      where: { id: containerImageId },
      data: {
        currentTag: tag,
        updateAvailable: false,
        ...(resolvedDigest ? { deployedDigest: resolvedDigest } : {}),
      },
    });
  }

  // Create history record
  return prisma.containerImageHistory.create({
    data: {
      containerImageId,
      tag,
      digest,
      deployedBy,
      status,
    },
  });
}

export interface EnhancedHistoryEntry extends ContainerImageHistory {
  deployments: {
    id: string;
    status: string;
    durationMs: number | null;
    triggeredBy: string;
    startedAt: Date;
    completedAt: Date | null;
    service: {
      id: string;
      name: string;
      server: {
        id: string;
        name: string;
      };
    } | null;
    user: {
      id: string;
      email: string;
      name: string | null;
    } | null;
  }[];
  // Computed fields
  totalDurationMs: number;
  deploymentCount: number;
  services: { id: string; name: string; serverName: string }[];
}

/**
 * Get tag deployment history for a container image with enhanced details
 */
export async function getTagHistory(
  containerImageId: string,
  limit: number = 20
): Promise<EnhancedHistoryEntry[]> {
  const history = await prisma.containerImageHistory.findMany({
    where: { containerImageId },
    orderBy: { deployedAt: 'desc' },
    take: limit,
    include: {
      deployments: {
        select: {
          id: true,
          status: true,
          durationMs: true,
          triggeredBy: true,
          startedAt: true,
          completedAt: true,
          service: {
            select: {
              id: true,
              name: true,
              server: {
                select: { id: true, name: true },
              },
            },
          },
          user: {
            select: { id: true, email: true, name: true },
          },
        },
      },
    },
  });

  // Enhance each history entry with computed fields
  return history.map((entry) => {
    const totalDurationMs = entry.deployments.reduce(
      (sum, d) => sum + (d.durationMs || 0),
      0
    );

    const services = entry.deployments
      .filter((d) => d.service)
      .map((d) => ({
        id: d.service!.id,
        name: d.service!.name,
        serverName: d.service!.server.name,
      }))
      // Remove duplicates
      .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

    return {
      ...entry,
      totalDurationMs,
      deploymentCount: entry.deployments.length,
      services,
    };
  });
}

/**
 * Get the previous tag for rollback
 */
export async function getPreviousTag(containerImageId: string): Promise<string | null> {
  const history = await prisma.containerImageHistory.findMany({
    where: { containerImageId, status: 'success' },
    orderBy: { deployedAt: 'desc' },
    take: 2,
  });

  // Return the second most recent successful tag (the one before current)
  return history.length > 1 ? history[1].tag : null;
}

/**
 * Get services linked to a container image, ordered by dependencies
 * Returns services grouped by their dependency level for orchestration
 */
export async function getLinkedServicesWithDependencies(
  containerImageId: string
): Promise<Service[]> {
  return prisma.service.findMany({
    where: { containerImageId },
    include: {
      server: true,
      dependencies: {
        include: {
          dependsOn: true,
        },
      },
      dependents: {
        include: {
          dependent: true,
        },
      },
    },
  });
}

/**
 * Check if a container image exists for an image name in an environment
 */
export async function findContainerImageByImageName(
  environmentId: string,
  imageName: string
): Promise<ContainerImage | null> {
  return prisma.containerImage.findUnique({
    where: {
      environmentId_imageName: {
        environmentId,
        imageName,
      },
    },
  });
}

/**
 * Find or create a container image for an image name
 * Used during container discovery to ensure every service has a ContainerImage
 */
export async function findOrCreateContainerImage(
  environmentId: string,
  imageName: string,
  imageTag: string,
  registryConnectionId?: string | null
): Promise<ContainerImage> {
  // Try to find existing
  const existing = await findContainerImageByImageName(environmentId, imageName);
  if (existing) {
    return existing;
  }

  // Extract display name from image path
  // e.g., "registry.digitalocean.com/my-registry/my-app" -> "my-app"
  const parts = imageName.split('/');
  const displayName = parts[parts.length - 1] || imageName;

  // Create new container image
  return prisma.containerImage.create({
    data: {
      name: displayName,
      imageName,
      currentTag: imageTag,
      environmentId,
      registryConnectionId,
    },
  });
}

/**
 * Shared update detection logic for container images.
 * Handles both version tags (tag name changes) and rolling tags (digest comparison).
 * Also discovers companion tags for rolling tags.
 */
export interface DetectUpdateResult {
  hasUpdate: boolean;
  latestTag: string | null;
  latestDigest: string | null;
}

export async function detectUpdate(
  imageId: string,
  currentTag: string,
  deployedDigest: string | null,
  allTags: RegistryTag[]
): Promise<DetectUpdateResult> {
  const { latestTag, currentDigest } = findLatestInFamily(allTags, currentTag);

  if (!latestTag) {
    return { hasUpdate: false, latestTag: null, latestDigest: null };
  }

  let hasUpdate = false;
  let resolvedLatestTag = latestTag.tag;

  if (latestTag.tag !== currentTag) {
    // Different tag name (version upgrade)
    if (!latestTag.digest || !currentDigest) {
      // Can't compare digests — if tag name is newer, assume update
      hasUpdate = true;
    } else {
      hasUpdate = currentDigest !== latestTag.digest;
    }
  } else {
    // Same tag name (rolling tag like "latest"): compare digests
    if (!latestTag.digest) {
      // Registry didn't return a digest — can't determine update status
      // Don't false-positive (was causing perpetual "latest available" badges)
      hasUpdate = false;
    } else if (deployedDigest) {
      hasUpdate = latestTag.digest !== deployedDigest;
    } else {
      // No deployedDigest yet — check history for the last successful deploy's digest
      const lastSuccessful = await prisma.containerImageHistory.findFirst({
        where: { containerImageId: imageId, status: 'success' },
        orderBy: { deployedAt: 'desc' },
        select: { digest: true },
      });

      if (lastSuccessful?.digest) {
        // History has a digest — compare it to the registry
        hasUpdate = latestTag.digest !== lastSuccessful.digest;
      } else {
        // No history digest at all — can't determine, don't false-positive
        hasUpdate = false;
      }
    }
  }

  // For rolling tags, try to find a companion tag (e.g., "latest" → "20260223-30a4f0b")
  if (latestTag.digest) {
    const companion = findCompanionTag(allTags, latestTag.tag, latestTag.digest);
    if (companion) {
      resolvedLatestTag = companion;
    }
  }

  // Update the containerImage with latest available info
  const updateData: Record<string, unknown> = {
    latestTag: resolvedLatestTag,
    latestDigest: latestTag.digest,
    lastCheckedAt: new Date(),
    updateAvailable: hasUpdate,
  };

  await prisma.containerImage.update({
    where: { id: imageId },
    data: updateData,
  });

  return {
    hasUpdate,
    latestTag: resolvedLatestTag,
    latestDigest: latestTag.digest ?? null,
  };
}

/**
 * List tags from the registry for a container image.
 * Encapsulates registry client creation and repo name extraction.
 */
export async function listImageTags(
  imageId: string
): Promise<{ tags: RegistryTag[]; currentTag: string; deployedDigest: string | null }> {
  const image = await prisma.containerImage.findUnique({
    where: { id: imageId },
    include: { registryConnection: true },
  });

  if (!image) {
    throw new Error('Container image not found');
  }

  if (!image.registryConnectionId) {
    throw new Error('No registry connection configured for this image');
  }

  const creds = await getRegistryCredentials(image.registryConnectionId);
  if (!creds) {
    throw new Error('Could not get registry credentials');
  }

  const client = RegistryFactory.create(creds);
  const repoName = extractRepoName(image.imageName, creds.repositoryPrefix);
  const tags = await client.listTags(repoName);

  return {
    tags,
    currentTag: image.currentTag,
    deployedDigest: image.deployedDigest,
  };
}
