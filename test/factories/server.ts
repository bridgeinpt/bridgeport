/**
 * Server factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestServerOptions {
  name?: string;
  hostname?: string;
  environmentId: string;
  dockerMode?: 'ssh' | 'socket';
  metricsMode?: 'disabled' | 'ssh' | 'agent';
  tags?: string[];
  publicIp?: string;
}

export async function createTestServer(
  prisma: PrismaClient,
  options: CreateTestServerOptions
) {
  const n = nextId();
  return prisma.server.create({
    data: {
      name: options.name ?? `server-${n}`,
      hostname: options.hostname ?? `192.168.1.${n}`,
      publicIp: options.publicIp,
      tags: JSON.stringify(options.tags ?? []),
      dockerMode: options.dockerMode ?? 'ssh',
      metricsMode: options.metricsMode ?? 'disabled',
      status: 'healthy',
      environmentId: options.environmentId,
    },
  });
}

export function resetServerCounter() {
  counter = 0;
}
