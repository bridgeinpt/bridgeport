import { prisma } from '../lib/db.js';
import type { ContainerImage, ContainerImageHistory, Service } from '@prisma/client';
import { RegistryFactory, type RegistryTag } from '../lib/registry.js';
import { extractRepoName, stripRegistryPrefix, parseTagFilter, getBestTag, getDefaultTag, matchesTagFilter } from '../lib/image-utils.js';
import { getRegistryCredentials } from './registries.js';
import { HISTORY_STATUS } from '../lib/constants.js';
import { safeJsonParse } from '../lib/helpers.js';

export interface CreateContainerImageInput {
  name: string;
  imageName: string;
  tagFilter?: string;
  environmentId: string;
  registryConnectionId?: string | null;
}

export interface UpdateContainerImageInput {
  name?: string;
  tagFilter?: string;
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
      tagFilter: input.tagFilter ?? 'latest',
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
 * Get a container image with its services and recent digests
 */
export async function getContainerImage(id: string): Promise<ContainerImage & { services: Service[] } | null> {
  return prisma.containerImage.findUnique({
    where: { id },
    include: {
      services: {
        include: {
          serviceDeployments: {
            include: {
              server: { select: { id: true, name: true, hostname: true, environmentId: true } },
              imageDigest: { select: { id: true, manifestDigest: true, tags: true } },
            },
          },
        },
      },
      registryConnection: true,
      deployedDigest: true,
      digests: {
        orderBy: { pushedAt: 'desc' },
        take: 20,
      },
    },
  });
}

/**
 * List container images for an environment.
 *
 * The previous shape used four nested `include`s — two of them with
 * `take: 1` — which made Prisma emit a correlated subquery per image row
 * (quadratic at scale, ~p99 67ms in stress tests for a moderate dataset).
 * The new shape:
 *   1. fetches the page of images + their registry connection (1-to-many
 *      parent, cheap JOIN),
 *   2. fetches services+server, latest digest, latest tagHistory in three
 *      parallel `findMany`s scoped by `containerImageId in [...]`,
 *   3. stitches the children onto each image in JS.
 * The shape of the returned objects is preserved.
 */
export async function listContainerImages(
  environmentId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ images: (ContainerImage & { services: Service[] })[]; total: number }> {
  const limit = options?.limit ?? 25;
  const offset = options?.offset ?? 0;
  const where = { environmentId };

  const [pageImages, total] = await Promise.all([
    prisma.containerImage.findMany({
      where,
      include: { registryConnection: true },
      orderBy: { name: 'asc' },
      take: limit,
      skip: offset,
    }),
    prisma.containerImage.count({ where }),
  ]);

  if (pageImages.length === 0) {
    return { images: [], total };
  }

  const imageIds = pageImages.map((img) => img.id);

  const [services, latestDigests, latestHistory] = await Promise.all([
    // Service.server moved to ServiceDeployment in 2.0; eager-load deployments
    // here so the page render still has access to each (service, server) pair
    // without an N+1.
    prisma.service.findMany({
      where: { containerImageId: { in: imageIds } },
      include: {
        serviceDeployments: { include: { server: true } },
      },
    }),
    // For each image, the digest with the max(pushedAt). One groupBy +
    // targeted findMany keeps this linear in image count.
    (async () => {
      const groups = await prisma.imageDigest.groupBy({
        by: ['containerImageId'],
        where: { containerImageId: { in: imageIds } },
        _max: { pushedAt: true },
      });
      const pairs = groups.filter((g) => g._max.pushedAt != null);
      if (pairs.length === 0) return [];
      return prisma.imageDigest.findMany({
        where: {
          OR: pairs.map((g) => ({
            containerImageId: g.containerImageId,
            pushedAt: g._max.pushedAt!,
          })),
        },
      });
    })(),
    (async () => {
      const groups = await prisma.containerImageHistory.groupBy({
        by: ['containerImageId'],
        where: { containerImageId: { in: imageIds } },
        _max: { deployedAt: true },
      });
      return groups
        .filter((g) => g._max.deployedAt != null)
        .map((g) => ({ containerImageId: g.containerImageId, deployedAt: g._max.deployedAt! }));
    })(),
  ]);

  const servicesByImage = new Map<string, typeof services>();
  for (const svc of services) {
    if (!svc.containerImageId) continue;
    const arr = servicesByImage.get(svc.containerImageId) ?? [];
    arr.push(svc);
    servicesByImage.set(svc.containerImageId, arr);
  }
  const latestDigestByImage = new Map(latestDigests.map((d) => [d.containerImageId, d]));
  const latestHistoryByImage = new Map(latestHistory.map((h) => [h.containerImageId, h]));

  const images = pageImages.map((img) => {
    const latest = latestDigestByImage.get(img.id);
    const history = latestHistoryByImage.get(img.id);
    return {
      ...img,
      services: servicesByImage.get(img.id) ?? [],
      tagHistory: history ? [{ deployedAt: history.deployedAt }] : [],
      digests: latest ? [latest] : [],
    };
  });

  return { images: images as (ContainerImage & { services: Service[] })[], total };
}

/**
 * Link a service to a container image
 * Only updates the containerImageId and syncs the imageTag/imageDigestId
 */
export async function linkServiceToContainerImage(
  containerImageId: string,
  serviceId: string
): Promise<Service> {
  const containerImage = await prisma.containerImage.findUniqueOrThrow({
    where: { id: containerImageId },
  });

  const latestDigest = await prisma.imageDigest.findFirst({
    where: { containerImageId },
    orderBy: { pushedAt: 'desc' },
  });

  const tagFilterPatterns = parseTagFilter(containerImage.tagFilter);
  let bestTag = getDefaultTag(containerImage.tagFilter);

  if (latestDigest) {
    const digestTags = safeJsonParse(latestDigest.tags, [] as string[]);
    bestTag = getBestTag(digestTags, tagFilterPatterns) || bestTag;
  }

  // imageDigestId now lives on ServiceDeployment, not Service. Update all
  // deployments of this service to point at the latest digest AND update the
  // Service template atomically — otherwise a failure between the two writes
  // would leave deployments pointing at a digest that no longer matches the
  // service's containerImageId.
  const [, service] = await prisma.$transaction([
    prisma.serviceDeployment.updateMany({
      where: { serviceId },
      data: { imageDigestId: latestDigest?.id ?? null },
    }),
    prisma.service.update({
      where: { id: serviceId },
      data: {
        containerImageId,
        imageTag: bestTag,
      },
    }),
  ]);

  return service;
}

/**
 * Record a tag deployment in history.
 * Auto-resolves the imageDigestId from the tag if not provided.
 * On success, sets ContainerImage.deployedDigestId and clears updateAvailable.
 */
export async function recordTagDeployment(
  containerImageId: string,
  tag: string,
  digest?: string,
  deployedBy?: string,
  status: 'success' | 'failed' | 'rolled_back' = HISTORY_STATUS.SUCCESS,
  imageDigestId?: string
): Promise<ContainerImageHistory> {
  // Auto-resolve imageDigestId from tag if not provided
  if (!imageDigestId && status === HISTORY_STATUS.SUCCESS) {
    const recentDigests = await prisma.imageDigest.findMany({
      where: { containerImageId },
      orderBy: { pushedAt: 'desc' },
      take: 50,
    });
    for (const d of recentDigests) {
      const tags = safeJsonParse(d.tags, [] as string[]);
      if (tags.includes(tag)) {
        imageDigestId = d.id;
        digest = digest || d.manifestDigest;
        break;
      }
    }
  }

  if (status === HISTORY_STATUS.SUCCESS) {
    // Update container image - clear updateAvailable and set deployedDigestId
    await prisma.containerImage.update({
      where: { id: containerImageId },
      data: {
        updateAvailable: false,
        ...(imageDigestId ? { deployedDigestId: imageDigestId } : {}),
      },
    });

    // Update all linked service deployments' imageDigestId (imageDigest moved from Service to ServiceDeployment)
    if (imageDigestId) {
      await prisma.serviceDeployment.updateMany({
        where: { service: { containerImageId } },
        data: { imageDigestId },
      });
    }
  }

  return prisma.containerImageHistory.create({
    data: {
      containerImageId,
      tag,
      digest,
      deployedBy,
      status,
      imageDigestId,
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
    } | null;
    serviceDeployment: {
      id: string;
      server: { id: string; name: string };
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
      imageDigest: {
        select: { id: true, manifestDigest: true, tags: true },
      },
      deployments: {
        select: {
          id: true,
          status: true,
          durationMs: true,
          triggeredBy: true,
          startedAt: true,
          completedAt: true,
          service: {
            select: { id: true, name: true },
          },
          serviceDeployment: {
            select: {
              id: true,
              server: { select: { id: true, name: true } },
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
        serverName: d.serviceDeployment?.server.name ?? '',
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
    where: { containerImageId, status: HISTORY_STATUS.SUCCESS },
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
      serviceDeployments: { include: { server: true } },
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
      tagFilter: imageTag,
      environmentId,
      registryConnectionId,
    },
  });
}

/**
 * Sync digest information from registry tags into ImageDigest records.
 * Filters tags by the image's tagFilter, groups by digest, and upserts records.
 * Returns whether there's an update available (newest digest not deployed).
 */
export interface SyncDigestsResult {
  newDigests: number;
  updatedDigests: number;
  hasUpdate: boolean;
  newestDigestId?: string;
}

export async function syncDigestsFromRegistry(
  imageId: string,
  registryTags: RegistryTag[]
): Promise<SyncDigestsResult> {
  const image = await prisma.containerImage.findUniqueOrThrow({
    where: { id: imageId },
    select: { tagFilter: true, deployedDigestId: true },
  });

  const patterns = parseTagFilter(image.tagFilter);

  // Group ALL tags by digest first
  const allByDigest = new Map<string, { tags: string[]; size?: number; updatedAt: string }>();
  for (const t of registryTags) {
    if (!t.digest) continue;
    const existing = allByDigest.get(t.digest);
    if (existing) {
      existing.tags.push(t.tag);
      if (t.updatedAt > existing.updatedAt) {
        existing.updatedAt = t.updatedAt;
        if (t.size) existing.size = t.size;
      }
    } else {
      allByDigest.set(t.digest, {
        tags: [t.tag],
        size: t.size,
        updatedAt: t.updatedAt,
      });
    }
  }

  // Only keep digests that have at least one tag matching the filter
  const byDigest = new Map<string, { tags: string[]; size?: number; updatedAt: string }>();
  for (const [digest, info] of allByDigest) {
    if (info.tags.some((tag) => matchesTagFilter(tag, patterns))) {
      byDigest.set(digest, info);
    }
  }

  let newDigests = 0;
  let updatedDigests = 0;

  // Upsert ImageDigest records
  for (const [digest, info] of byDigest) {
    const existing = await prisma.imageDigest.findUnique({
      where: {
        containerImageId_manifestDigest: {
          containerImageId: imageId,
          manifestDigest: digest,
        },
      },
    });

    if (existing) {
      // Update tags if changed
      const existingTags = safeJsonParse(existing.tags, [] as string[]);
      const tagsChanged = JSON.stringify(existingTags.sort()) !== JSON.stringify(info.tags.sort());
      if (tagsChanged) {
        await prisma.imageDigest.update({
          where: { id: existing.id },
          data: { tags: JSON.stringify(info.tags) },
        });
        updatedDigests++;
      }
    } else {
      await prisma.imageDigest.create({
        data: {
          containerImageId: imageId,
          manifestDigest: digest,
          tags: JSON.stringify(info.tags),
          size: info.size ? BigInt(info.size) : null,
          pushedAt: new Date(info.updatedAt),
        },
      });
      newDigests++;
    }
  }

  // Determine if there's an update available
  // Get the most recently pushed digest
  const newestDigest = await prisma.imageDigest.findFirst({
    where: { containerImageId: imageId },
    orderBy: { pushedAt: 'desc' },
  });

  // There's an update if the newest digest differs from the deployed one
  const hasUpdate = newestDigest !== null && newestDigest.id !== image.deployedDigestId;

  await prisma.containerImage.update({
    where: { id: imageId },
    data: {
      lastCheckedAt: new Date(),
      updateAvailable: hasUpdate,
    },
  });

  return { newDigests, updatedDigests, hasUpdate, newestDigestId: newestDigest?.id };
}

/**
 * List digests for a container image with pagination and bestTag computation.
 */
export async function listImageDigests(
  imageId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ digests: any[]; total: number }> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  const where = { containerImageId: imageId };

  const [digests, total, image] = await Promise.all([
    prisma.imageDigest.findMany({
      where,
      orderBy: { pushedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.imageDigest.count({ where }),
    prisma.containerImage.findUnique({
      where: { id: imageId },
      select: { tagFilter: true },
    }),
  ]);

  const patterns = image ? parseTagFilter(image.tagFilter) : [];

  const digestsWithBestTag = digests.map((d) => {
    const tags = safeJsonParse(d.tags, [] as string[]);
    return {
      ...d,
      tags,
      size: d.size !== null ? Number(d.size) : null,
      bestTag: getBestTag(tags, patterns),
    };
  });

  return { digests: digestsWithBestTag, total };
}

/**
 * Get a single image digest with its linked services and parent image info.
 */
/**
 * Clean up old ImageDigest records not referenced by any Service or History.
 */
export async function cleanupOldImageDigests(retentionDays: number = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await prisma.imageDigest.deleteMany({
    where: {
      discoveredAt: { lt: cutoff },
      serviceDeployments: { none: {} },
      historyEntries: { none: {} },
    },
  });
  return deleted.count;
}

export async function getImageDigest(digestId: string) {
  return prisma.imageDigest.findUnique({
    where: { id: digestId },
    include: {
      serviceDeployments: {
        select: {
          id: true,
          server: { select: { id: true, name: true } },
          service: { select: { id: true, name: true } },
        },
      },
      containerImage: { select: { id: true, tagFilter: true } },
    },
  });
}

/**
 * List tags from the registry for a container image.
 * Encapsulates registry client creation and repo name extraction.
 */
export async function listImageTags(
  imageId: string
): Promise<{ tags: RegistryTag[]; tagFilter: string }> {
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
  const repoName = creds.type === 'digitalocean'
    ? extractRepoName(image.imageName, creds.repositoryPrefix)
    : stripRegistryPrefix(image.imageName);
  const tags = await client.listTags(repoName);

  return {
    tags,
    tagFilter: image.tagFilter,
  };
}
