/**
 * Service (template) and ServiceDeployment (per-server runtime) factories for tests.
 *
 * In 2.0 a Service is a template (env-scoped, owns image + base config). A
 * ServiceDeployment binds a template to a server and holds per-server runtime
 * state (container name, runtime status, env overrides).
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestServiceOptions {
  name?: string;
  environmentId: string;
  containerImageId: string;
  imageTag?: string;
  healthCheckUrl?: string;
  baseEnv?: Record<string, string> | null;
  deployStrategy?: 'sequential' | 'parallel';

  // Legacy: if a caller passes serverId/containerName, also create a ServiceDeployment.
  // Older tests (smoke, security) expect createTestService to provision an attached deployment.
  serverId?: string;
  containerName?: string;
  envOverrides?: Record<string, string> | null;
}

export async function createTestService(
  prisma: PrismaClient,
  options: CreateTestServiceOptions
) {
  const n = nextId();
  const service = await prisma.service.create({
    data: {
      name: options.name ?? `service-${n}`,
      imageTag: options.imageTag ?? 'latest',
      healthCheckUrl: options.healthCheckUrl,
      baseEnv: options.baseEnv ? JSON.stringify(options.baseEnv) : null,
      deployStrategy: options.deployStrategy ?? 'sequential',
      environmentId: options.environmentId,
      containerImageId: options.containerImageId,
    },
  });

  // Legacy compatibility: if serverId provided, also create a deployment row.
  if (options.serverId) {
    await prisma.serviceDeployment.create({
      data: {
        serviceId: service.id,
        serverId: options.serverId,
        containerName: options.containerName ?? `container-${n}`,
        envOverrides: options.envOverrides ? JSON.stringify(options.envOverrides) : null,
      },
    });
  }

  return service;
}

export interface CreateTestServiceDeploymentOptions {
  serviceId: string;
  serverId: string;
  containerName?: string;
  composePath?: string | null;
  envOverrides?: Record<string, string> | null;
}

export async function createTestServiceDeployment(
  prisma: PrismaClient,
  options: CreateTestServiceDeploymentOptions
) {
  const n = nextId();
  return prisma.serviceDeployment.create({
    data: {
      serviceId: options.serviceId,
      serverId: options.serverId,
      containerName: options.containerName ?? `container-${n}`,
      composePath: options.composePath ?? null,
      envOverrides: options.envOverrides ? JSON.stringify(options.envOverrides) : null,
    },
  });
}

export function resetServiceCounter() {
  counter = 0;
}
