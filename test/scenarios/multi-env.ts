/**
 * Multi-environment scenario.
 *
 * Creates two environments (staging + production) sharing the same
 * container image but with different servers and services.
 */
import { PrismaClient } from '@prisma/client';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService } from '../factories/service.js';
import { createTestUser } from '../factories/user.js';

export async function createMultiEnvScenario(prisma: PrismaClient) {
  const admin = await createTestUser(prisma, {
    email: 'admin@test.com',
    role: 'admin',
  });

  // Staging environment
  const staging = await createTestEnvironment(prisma, { name: 'staging' });
  const stagingServer = await createTestServer(prisma, {
    name: 'staging-web',
    hostname: '10.0.1.1',
    environmentId: staging.id,
  });
  const stagingImage = await createTestContainerImage(prisma, {
    name: 'App Staging',
    imageName: 'registry.example.com/myapp',
    currentTag: 'v1.1.0',
    environmentId: staging.id,
  });
  const stagingService = await createTestService(prisma, {
    name: 'app-staging',
    containerName: 'app-staging',
    serverId: stagingServer.id,
    containerImageId: stagingImage.id,
    imageTag: 'v1.1.0',
  });

  // Production environment
  const production = await createTestEnvironment(prisma, { name: 'production' });
  const prodServer = await createTestServer(prisma, {
    name: 'prod-web',
    hostname: '10.0.2.1',
    environmentId: production.id,
  });
  const prodImage = await createTestContainerImage(prisma, {
    name: 'App Production',
    imageName: 'registry.example.com/myapp',
    currentTag: 'v1.0.0',
    environmentId: production.id,
  });
  const prodService = await createTestService(prisma, {
    name: 'app-prod',
    containerName: 'app-prod',
    serverId: prodServer.id,
    containerImageId: prodImage.id,
    imageTag: 'v1.0.0',
  });

  return {
    admin,
    staging: {
      env: staging,
      server: stagingServer,
      image: stagingImage,
      service: stagingService,
    },
    production: {
      env: production,
      server: prodServer,
      image: prodImage,
      service: prodService,
    },
  };
}
