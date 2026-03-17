/**
 * Notification storm scenario.
 *
 * Creates a scenario with multiple rapid health check failures
 * that should trigger bounce logic. Useful for testing the
 * BounceTracker and notification suppression.
 */
import { PrismaClient } from '@prisma/client';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService } from '../factories/service.js';
import { createTestUser } from '../factories/user.js';
import { createTestNotificationType } from '../factories/notification.js';

export async function createNotificationStormScenario(prisma: PrismaClient) {
  const admin = await createTestUser(prisma, {
    email: 'admin@test.com',
    role: 'admin',
  });

  const env = await createTestEnvironment(prisma, { name: 'production' });

  const server = await createTestServer(prisma, {
    name: 'web-01',
    environmentId: env.id,
  });

  const image = await createTestContainerImage(prisma, {
    name: 'Unstable App',
    imageName: 'registry.example.com/unstable',
    tagFilter: 'v1.0.0',
    environmentId: env.id,
  });

  const service = await createTestService(prisma, {
    name: 'unstable-service',
    containerName: 'unstable',
    serverId: server.id,
    containerImageId: image.id,
  });

  // Create a notification type with bounce logic
  const healthCheckType = await createTestNotificationType(prisma, {
    category: 'system',
    code: 'system.health_check_failed',
    name: 'Health Check Failed',
    template: 'Health check failed for {{serviceName}}',
    severity: 'warning',
    bounceEnabled: true,
    bounceThreshold: 3,
  });

  // Create a bounce tracker with accumulated failures
  const bounceTracker = await prisma.bounceTracker.create({
    data: {
      resourceType: 'service',
      resourceId: service.id,
      eventType: 'health_check',
      consecutiveFailures: 5, // Past the threshold
      lastFailedAt: new Date(),
      alertSentAt: new Date(Date.now() - 60000), // Alert was sent 1 minute ago
    },
  });

  return {
    admin,
    env,
    server,
    image,
    service,
    healthCheckType,
    bounceTracker,
  };
}
