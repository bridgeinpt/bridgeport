/**
 * Environment factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestEnvironmentOptions {
  name?: string;
  sshPrivateKey?: string;
}

export async function createTestEnvironment(
  prisma: PrismaClient,
  options: CreateTestEnvironmentOptions = {}
) {
  const n = nextId();
  return prisma.environment.create({
    data: {
      name: options.name ?? `test-env-${n}`,
      sshPrivateKey: options.sshPrivateKey,
    },
  });
}

export function resetEnvironmentCounter() {
  counter = 0;
}
