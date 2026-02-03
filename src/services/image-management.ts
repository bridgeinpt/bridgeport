import { prisma } from '../lib/db.js';
import type { ContainerImage, ContainerImageHistory, Service } from '@prisma/client';

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
export async function listContainerImages(environmentId: string): Promise<(ContainerImage & { services: Service[] })[]> {
  return prisma.containerImage.findMany({
    where: { environmentId },
    include: {
      services: {
        include: {
          server: true,
        },
      },
      registryConnection: true,
    },
    orderBy: { name: 'asc' },
  });
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
    await prisma.containerImage.update({
      where: { id: containerImageId },
      data: { currentTag: tag },
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
  // e.g., "registry.digitalocean.com/bios-registry/bios-backend" -> "bios-backend"
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
