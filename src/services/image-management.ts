import { prisma } from '../lib/db.js';
import type { ManagedImage, ImageTagHistory, Service } from '@prisma/client';

export interface CreateManagedImageInput {
  name: string;
  imageName: string;
  currentTag: string;
  environmentId: string;
  registryConnectionId?: string | null;
}

export interface UpdateManagedImageInput {
  name?: string;
  currentTag?: string;
  latestTag?: string;
  latestDigest?: string;
  lastCheckedAt?: Date;
  registryConnectionId?: string | null;
}

/**
 * Create a new managed image
 */
export async function createManagedImage(
  input: CreateManagedImageInput
): Promise<ManagedImage> {
  return prisma.managedImage.create({
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
 * Update a managed image
 */
export async function updateManagedImage(
  id: string,
  input: UpdateManagedImageInput
): Promise<ManagedImage> {
  return prisma.managedImage.update({
    where: { id },
    data: input,
  });
}

/**
 * Delete a managed image
 */
export async function deleteManagedImage(id: string): Promise<void> {
  // First unlink all services
  await prisma.service.updateMany({
    where: { managedImageId: id },
    data: { managedImageId: null },
  });

  await prisma.managedImage.delete({
    where: { id },
  });
}

/**
 * Get a managed image with its services
 */
export async function getManagedImage(id: string): Promise<ManagedImage & { services: Service[] } | null> {
  return prisma.managedImage.findUnique({
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
 * List managed images for an environment
 */
export async function listManagedImages(environmentId: string): Promise<(ManagedImage & { services: Service[] })[]> {
  return prisma.managedImage.findMany({
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
 * Link a service to a managed image
 */
export async function linkServiceToManagedImage(
  managedImageId: string,
  serviceId: string
): Promise<Service> {
  const managedImage = await prisma.managedImage.findUniqueOrThrow({
    where: { id: managedImageId },
  });

  // Update the service's imageName and imageTag to match the managed image
  return prisma.service.update({
    where: { id: serviceId },
    data: {
      managedImageId,
      imageName: managedImage.imageName,
      imageTag: managedImage.currentTag,
    },
  });
}

/**
 * Unlink a service from its managed image
 */
export async function unlinkServiceFromManagedImage(serviceId: string): Promise<Service> {
  return prisma.service.update({
    where: { id: serviceId },
    data: { managedImageId: null },
  });
}

/**
 * Record a tag deployment in history
 */
export async function recordTagDeployment(
  managedImageId: string,
  tag: string,
  digest?: string,
  deployedBy?: string
): Promise<ImageTagHistory> {
  // Update the managed image's current tag
  await prisma.managedImage.update({
    where: { id: managedImageId },
    data: { currentTag: tag },
  });

  // Create history record
  return prisma.imageTagHistory.create({
    data: {
      managedImageId,
      tag,
      digest,
      deployedBy,
    },
  });
}

/**
 * Get tag deployment history for a managed image
 */
export async function getTagHistory(
  managedImageId: string,
  limit: number = 20
): Promise<ImageTagHistory[]> {
  return prisma.imageTagHistory.findMany({
    where: { managedImageId },
    orderBy: { deployedAt: 'desc' },
    take: limit,
  });
}

/**
 * Get the previous tag for rollback
 */
export async function getPreviousTag(managedImageId: string): Promise<string | null> {
  const history = await prisma.imageTagHistory.findMany({
    where: { managedImageId },
    orderBy: { deployedAt: 'desc' },
    take: 2,
  });

  // Return the second most recent tag (the one before current)
  return history.length > 1 ? history[1].tag : null;
}

/**
 * Get services linked to a managed image, ordered by dependencies
 * Returns services grouped by their dependency level for orchestration
 */
export async function getLinkedServicesWithDependencies(
  managedImageId: string
): Promise<Service[]> {
  return prisma.service.findMany({
    where: { managedImageId },
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
 * Check if a managed image exists for an image name in an environment
 */
export async function findManagedImageByImageName(
  environmentId: string,
  imageName: string
): Promise<ManagedImage | null> {
  return prisma.managedImage.findUnique({
    where: {
      environmentId_imageName: {
        environmentId,
        imageName,
      },
    },
  });
}

/**
 * Get all services using a specific image name that are not linked to a managed image
 */
export async function findUnlinkedServicesByImageName(
  environmentId: string,
  imageName: string
): Promise<Service[]> {
  return prisma.service.findMany({
    where: {
      imageName,
      managedImageId: null,
      server: {
        environmentId,
      },
    },
    include: {
      server: true,
    },
  });
}
