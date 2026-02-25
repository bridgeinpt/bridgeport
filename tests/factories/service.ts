/**
 * Service factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestServiceOptions {
  name?: string;
  containerName?: string;
  serverId: string;
  containerImageId: string;
  imageTag?: string;
  healthCheckUrl?: string;
}

export async function createTestService(
  prisma: PrismaClient,
  options: CreateTestServiceOptions
) {
  const n = nextId();
  return prisma.service.create({
    data: {
      name: options.name ?? `service-${n}`,
      containerName: options.containerName ?? `container-${n}`,
      imageTag: options.imageTag ?? 'latest',
      healthCheckUrl: options.healthCheckUrl,
      serverId: options.serverId,
      containerImageId: options.containerImageId,
    },
  });
}

export function resetServiceCounter() {
  counter = 0;
}
