/**
 * Healthy deployment scenario.
 *
 * Creates a complete environment with a server, container image, service,
 * and a successful deployment. Useful as a base scenario for many tests.
 */
import { PrismaClient } from '@prisma/client';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService } from '../factories/service.js';
import { createTestDeployment } from '../factories/deployment.js';
import { createTestUser } from '../factories/user.js';

export async function createHealthyDeploymentScenario(prisma: PrismaClient) {
  const user = await createTestUser(prisma, {
    email: 'deployer@test.com',
    role: 'operator',
  });

  const env = await createTestEnvironment(prisma, { name: 'production' });

  const server = await createTestServer(prisma, {
    name: 'web-01',
    hostname: '10.0.0.1',
    environmentId: env.id,
  });

  const image = await createTestContainerImage(prisma, {
    name: 'My App',
    imageName: 'registry.example.com/myapp',
    currentTag: 'v1.0.0',
    environmentId: env.id,
  });

  const service = await createTestService(prisma, {
    name: 'myapp',
    containerName: 'myapp-container',
    serverId: server.id,
    containerImageId: image.id,
    imageTag: 'v1.0.0',
  });

  const deployment = await createTestDeployment(prisma, {
    serviceId: service.id,
    imageTag: 'v1.0.0',
    status: 'success',
    userId: user.id,
    triggeredBy: user.email,
  });

  return { user, env, server, image, service, deployment };
}
