import { initSentry, captureException, flushSentry, getSentryConfig } from './lib/sentry.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, readFile } from 'fs/promises';
import { config } from './lib/config.js';
import { initializeCrypto } from './lib/crypto.js';
import { initializeDatabase, disconnectDatabase } from './lib/db.js';
import authenticatePlugin from './plugins/authenticate.js';
import { authRoutes } from './routes/auth.js';
import { bootstrapAdminUser } from './services/auth.js';
import { bootstrapManagementEnvironment } from './services/host-detection.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { environmentRoutes } from './routes/environments.js';
import { serverRoutes } from './routes/servers.js';
import { serviceRoutes } from './routes/services.js';
import { secretRoutes } from './routes/secrets.js';
import { webhookRoutes } from './routes/webhooks.js';
import { composeRoutes } from './routes/compose.js';
import { auditRoutes } from './routes/audit.js';
import { configFileRoutes } from './routes/config-files.js';
import { registryRoutes } from './routes/registries.js';
import { userRoutes } from './routes/users.js';
import { metricsRoutes } from './routes/metrics.js';
import { databaseRoutes } from './routes/databases.js';
import { notificationRoutes } from './routes/notifications.js';
import { smtpRoutes } from './routes/admin/smtp.js';
import { webhookAdminRoutes } from './routes/admin/webhooks.js';
import { slackAdminRoutes } from './routes/admin/slack.js';
import { initializeNotificationTypes } from './services/notifications.js';
import { syncPlugins } from './services/plugin-loader.js';
import { containerImageRoutes } from './routes/container-images.js';
import { serviceDependencyRoutes } from './routes/service-dependencies.js';
import { deploymentPlanRoutes } from './routes/deployment-plans.js';
import { settingsRoutes } from './routes/settings.js';
import { spacesRoutes } from './routes/spaces.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { systemSettingsRoutes } from './routes/system-settings.js';
import { downloadRoutes } from './routes/downloads.js';
import { topologyRoutes } from './routes/topology.js';
import { environmentSettingsRoutes } from './routes/environment-settings.js';
import { eventRoutes } from './routes/events.js';
import { sshPool } from './lib/ssh.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read app version at startup
let appVersion = 'unknown';
try {
  const packageJson = JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf-8'));
  appVersion = packageJson.version;
} catch { /* dev mode fallback */ }

// Re-export from lib/version for backwards compat (routes import from lib/version directly)
import { bundledAgentVersion, cliVersion } from './lib/version.js';
export { bundledAgentVersion, cliVersion };

// Initialize Sentry error monitoring (no-op if SENTRY_DSN is not set)
initSentry(appVersion);

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // Initialize crypto with master key
  initializeCrypto(config.MASTER_KEY);

  // Initialize database
  await initializeDatabase();

  // Bootstrap admin user from env vars (if configured and no users exist)
  await bootstrapAdminUser(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);

  // Bootstrap management environment with host server
  await bootstrapManagementEnvironment();

  // Initialize notification types
  await initializeNotificationTypes();

  // Sync plugin-based types (service types + database types)
  await syncPlugins();

  // Ensure upload directory exists
  await mkdir(config.UPLOAD_DIR, { recursive: true });

  // Register plugins
  await fastify.register(cors, {
    origin: config.NODE_ENV === 'development'
      ? true
      : config.CORS_ORIGIN
        ? config.CORS_ORIGIN.split(',').map(s => s.trim())
        : ['https://deploy.bridgein.com'],
    credentials: true,
  });

  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  // Register authenticate decorator (must be before routes)
  await fastify.register(authenticatePlugin);

  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB for asset files
    },
  });

  // Custom JSON parser that allows empty bodies
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

  // API routes
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
  // Health check
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: appVersion,
      bundledAgentVersion,
      cliVersion,
    };
  });

  // Client config (public endpoint for frontend Sentry init)
  fastify.get('/api/client-config', async () => {
    const sentry = getSentryConfig(appVersion);
    return {
      sentryDsn: sentry.frontendDsn || null,
      sentryEnvironment: sentry.environment,
      sentryRelease: sentry.release,
    };
  });

  // Capture 5xx errors to Sentry
  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      captureException(error, {
        method: request.method,
        url: request.url,
        statusCode,
      });
    }
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
    });
  });

  // Serve static files in production
  if (config.NODE_ENV === 'production') {
    await fastify.register(fastifyStatic, {
      root: join(__dirname, '../ui/dist'),
      prefix: '/',
    });

    // SPA fallback
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // Start scheduler for periodic health checks
  if (config.SCHEDULER_ENABLED) {
    startScheduler({
      serverHealthIntervalMs: config.SCHEDULER_SERVER_HEALTH_INTERVAL * 1000,
      serviceHealthIntervalMs: config.SCHEDULER_SERVICE_HEALTH_INTERVAL * 1000,
      discoveryIntervalMs: config.SCHEDULER_DISCOVERY_INTERVAL * 1000,
      updateCheckIntervalMs: config.SCHEDULER_UPDATE_CHECK_INTERVAL * 1000,
      metricsIntervalMs: config.SCHEDULER_METRICS_INTERVAL * 1000,
      backupCheckIntervalMs: config.SCHEDULER_BACKUP_CHECK_INTERVAL * 1000,
      metricsRetentionDays: config.METRICS_RETENTION_DAYS,
    });
  }

  // Graceful shutdown
  const shutdown = async () => {
    fastify.log.info('Shutting down...');
    stopScheduler();
    sshPool.shutdown();
    await fastify.close();
    await disconnectDatabase();
    await flushSentry();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (error) => {
    captureException(error, { mechanism: 'uncaughtException' });
    console.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason) => {
    captureException(reason, { mechanism: 'unhandledRejection' });
    console.error('Unhandled rejection:', reason);
  });

  return fastify;
}

async function main() {
  try {
    const server = await buildServer();

    await server.listen({
      host: config.HOST,
      port: config.PORT,
    });

    console.log(`🚀 BridgePort running at http://${config.HOST}:${config.PORT}`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
