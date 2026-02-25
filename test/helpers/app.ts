/**
 * Fastify test app builder for integration tests.
 *
 * Creates a fully-configured Fastify instance with all routes and plugins,
 * backed by a test database. Uses the same plugin/route registration as
 * the production server (src/server.ts) but without starting the scheduler,
 * without serving static files, and without process-level signal handlers.
 *
 * Usage:
 *   const app = await buildTestApp();
 *   const res = await app.inject({ method: 'GET', url: '/health' });
 *   await app.close();
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { setupTestDb, teardownTestDb, getTestPrisma } from './db.js';
import { initializeCrypto } from '../../src/lib/crypto.js';
import authenticatePlugin from '../../src/plugins/authenticate.js';

// Route imports
import { authRoutes } from '../../src/routes/auth.js';
import { environmentRoutes } from '../../src/routes/environments.js';
import { serverRoutes } from '../../src/routes/servers.js';
import { serviceRoutes } from '../../src/routes/services.js';
import { secretRoutes } from '../../src/routes/secrets.js';
import { webhookRoutes } from '../../src/routes/webhooks.js';
import { composeRoutes } from '../../src/routes/compose.js';
import { auditRoutes } from '../../src/routes/audit.js';
import { configFileRoutes } from '../../src/routes/config-files.js';
import { registryRoutes } from '../../src/routes/registries.js';
import { userRoutes } from '../../src/routes/users.js';
import { metricsRoutes } from '../../src/routes/metrics.js';
import { databaseRoutes } from '../../src/routes/databases.js';
import { notificationRoutes } from '../../src/routes/notifications.js';
import { smtpRoutes } from '../../src/routes/admin/smtp.js';
import { webhookAdminRoutes } from '../../src/routes/admin/webhooks.js';
import { slackAdminRoutes } from '../../src/routes/admin/slack.js';
import { containerImageRoutes } from '../../src/routes/container-images.js';
import { serviceDependencyRoutes } from '../../src/routes/service-dependencies.js';
import { deploymentPlanRoutes } from '../../src/routes/deployment-plans.js';
import { settingsRoutes } from '../../src/routes/settings.js';
import { spacesRoutes } from '../../src/routes/spaces.js';
import { monitoringRoutes } from '../../src/routes/monitoring.js';
import { systemSettingsRoutes } from '../../src/routes/system-settings.js';
import { downloadRoutes } from '../../src/routes/downloads.js';
import { topologyRoutes } from '../../src/routes/topology.js';
import { environmentSettingsRoutes } from '../../src/routes/environment-settings.js';
import { eventRoutes } from '../../src/routes/events.js';

export interface TestApp extends FastifyInstance {
  prisma: PrismaClient;
}

export interface BuildTestAppOptions {
  /** Skip database setup (useful if you manage it separately) */
  skipDbSetup?: boolean;
}

/**
 * Build a fully-configured Fastify instance for testing.
 *
 * The returned instance has an additional `prisma` property for direct
 * database access in test assertions.
 */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  // Initialize crypto with the test master key
  initializeCrypto(process.env.MASTER_KEY!);

  // Set up the test database unless caller opted out
  let prisma: PrismaClient;
  if (options.skipDbSetup) {
    prisma = getTestPrisma();
  } else {
    prisma = await setupTestDb();
  }

  const fastify = Fastify({
    logger: false, // Quiet in tests
  });

  // Custom JSON parser that allows empty bodies (matches production server)
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (!body || body === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Register plugins
  await fastify.register(cors, { origin: true, credentials: true });
  await fastify.register(jwt, { secret: process.env.JWT_SECRET! });
  await fastify.register(authenticatePlugin);
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Register all API routes
  await fastify.register(authRoutes);
  await fastify.register(environmentRoutes);
  await fastify.register(serverRoutes);
  await fastify.register(serviceRoutes);
  await fastify.register(secretRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(composeRoutes);
  await fastify.register(auditRoutes);
  await fastify.register(configFileRoutes);
  await fastify.register(registryRoutes);
  await fastify.register(userRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(databaseRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(smtpRoutes);
  await fastify.register(webhookAdminRoutes);
  await fastify.register(slackAdminRoutes);
  await fastify.register(containerImageRoutes);
  await fastify.register(serviceDependencyRoutes);
  await fastify.register(deploymentPlanRoutes);
  await fastify.register(settingsRoutes);
  await fastify.register(spacesRoutes);
  await fastify.register(monitoringRoutes);
  await fastify.register(systemSettingsRoutes);
  await fastify.register(downloadRoutes);
  await fastify.register(topologyRoutes);
  await fastify.register(environmentSettingsRoutes);
  await fastify.register(eventRoutes);

  // Health check endpoint
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: 'test',
  }));

  // Error handler matching production behavior
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });

  // Attach prisma to the instance for test access
  const testApp = fastify as TestApp;
  testApp.prisma = prisma;

  // Override close to also tear down the test database
  const originalClose = fastify.close.bind(fastify);
  fastify.close = async () => {
    await originalClose();
    if (!options.skipDbSetup) {
      await teardownTestDb();
    }
  };

  await fastify.ready();

  return testApp;
}
