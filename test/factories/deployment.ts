/**
 * Deployment factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestDeploymentOptions {
  serviceId: string;
  imageTag?: string;
  previousTag?: string;
  status?: 'pending' | 'deploying' | 'success' | 'failed';
  logs?: string;
  triggeredBy?: string;
  userId?: string;
  containerImageHistoryId?: string;
  durationMs?: number;
}

export async function createTestDeployment(
  prisma: PrismaClient,
  options: CreateTestDeploymentOptions
) {
  const n = nextId();
  return prisma.deployment.create({
    data: {
      imageTag: options.imageTag ?? `v1.0.${n}`,
      previousTag: options.previousTag,
      status: options.status ?? 'success',
      logs: options.logs ?? `Deployment ${n} completed successfully`,
      triggeredBy: options.triggeredBy ?? 'test@test.com',
      durationMs: options.durationMs ?? 5000,
      completedAt: options.status === 'pending' || options.status === 'deploying'
        ? undefined
        : new Date(),
      serviceId: options.serviceId,
      userId: options.userId,
      containerImageHistoryId: options.containerImageHistoryId,
    },
  });
}

export function resetDeploymentCounter() {
  counter = 0;
}
