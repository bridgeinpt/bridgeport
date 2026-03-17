/**
 * ContainerImage and ImageDigest factories for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestContainerImageOptions {
  name?: string;
  environmentId: string;
  imageName?: string;
  tagFilter?: string;
  autoUpdate?: boolean;
  registryConnectionId?: string;
}

export async function createTestContainerImage(
  prisma: PrismaClient,
  options: CreateTestContainerImageOptions
) {
  const n = nextId();
  return prisma.containerImage.create({
    data: {
      name: options.name ?? `Test Image ${n}`,
      imageName: options.imageName ?? `registry.example.com/test-image-${n}`,
      tagFilter: options.tagFilter ?? 'latest',
      autoUpdate: options.autoUpdate ?? false,
      environmentId: options.environmentId,
      registryConnectionId: options.registryConnectionId,
    },
  });
}

export interface CreateTestImageDigestOptions {
  containerImageId: string;
  manifestDigest?: string;
  tags?: string[];
  size?: bigint;
  pushedAt?: Date;
}

export async function createTestImageDigest(
  prisma: PrismaClient,
  options: CreateTestImageDigestOptions
) {
  const n = nextId();
  return prisma.imageDigest.create({
    data: {
      containerImageId: options.containerImageId,
      manifestDigest: options.manifestDigest ?? `sha256:${n.toString().padStart(64, 'a')}`,
      tags: JSON.stringify(options.tags ?? ['latest']),
      size: options.size,
      pushedAt: options.pushedAt,
    },
  });
}

export function resetContainerImageCounter() {
  counter = 0;
}
