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
import { initializeNotificationTypes } from './services/notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json at startup
let appVersion = 'unknown';
try {
  const packageJson = JSON.parse(
    await readFile(join(__dirname, '../package.json'), 'utf-8')
  );
  appVersion = packageJson.version;
} catch {
  // Fallback if package.json can't be read
}

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

  // Initialize notification types
  await initializeNotificationTypes();

  // Ensure upload directory exists
  await mkdir(config.UPLOAD_DIR, { recursive: true });

  // Register plugins
  await fastify.register(cors, {
    origin: config.NODE_ENV === 'development' ? true : ['https://deploy.bridgein.com'],
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

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString(), version: appVersion };
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
    await fastify.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
