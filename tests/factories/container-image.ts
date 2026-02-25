/**
 * ContainerImage factory for tests.
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
  currentTag?: string;
  latestTag?: string;
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
      currentTag: options.currentTag ?? 'latest',
      latestTag: options.latestTag,
      autoUpdate: options.autoUpdate ?? false,
      environmentId: options.environmentId,
      registryConnectionId: options.registryConnectionId,
    },
  });
}

export function resetContainerImageCounter() {
  counter = 0;
}
