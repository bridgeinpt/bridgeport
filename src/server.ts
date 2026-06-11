import { initSentry, captureException, flushSentry, getSentryConfig } from './lib/sentry.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { buildCorsOptions } from './lib/cors.js';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir } from 'fs/promises';
import { config } from './lib/config.js';
import { initializeCrypto } from './lib/crypto.js';
import { initializeDatabase, disconnectDatabase } from './lib/db.js';
import authenticatePlugin from './plugins/authenticate.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openapiPlugin from './plugins/openapi.js';
import { registerApiRoutes } from './register-routes.js';
import { bootstrapAdminUser } from './services/auth.js';
import { bootstrapManagementEnvironment } from './services/host-detection.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { initializeNotificationTypes } from './services/notifications.js';
import { flushNotificationQueue } from './services/notification-queue.js';
import { syncPlugins } from './services/plugin-loader.js';
import { sshPool } from './lib/ssh.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-export from lib/version for backwards compat (routes import from lib/version directly)
import { appVersion, bundledAgentVersion, cliVersion } from './lib/version.js';
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

  // Route `schema` options (body/params/querystring) are attached for OpenAPI
  // DOCUMENTATION ONLY — derived from the existing Zod schemas via
  // src/lib/openapi-schema.ts. Runtime validation stays with Zod
  // (`validateBody`/`validateUpdateBody`), which preserves the readonly-field
  // 422 logic and the custom error envelope. A no-op validator compiler tells
  // Fastify NOT to compile/validate those schemas with Ajv (which also can't
  // parse the OpenAPI 3.0 dialect, e.g. boolean `exclusiveMinimum`). The app
  // has never relied on Fastify request validation, so this changes no behavior
  // — it just keeps the doc schemas inert. @fastify/swagger still reads them for
  // the spec, and `response` schemas still use the separate serializer compiler.
  fastify.setValidatorCompiler(() => () => true);

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
  // In production, CORS_ORIGIN must be set explicitly. If unset, cross-origin
  // requests are rejected (same-origin only) — a safe default for self-hosted deployments.
  if (config.NODE_ENV === 'production' && !config.CORS_ORIGIN) {
    fastify.log.warn(
      'CORS_ORIGIN is not set. Cross-origin requests will be rejected. ' +
      'Set CORS_ORIGIN to your UI origin(s) (comma-separated) if the UI is served from a different origin.'
    );
  }
  await fastify.register(cors, buildCorsOptions(config));

  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  // Global rate limiting — 100 requests/minute per client IP.
  // Self-hosted admin tools rarely see legitimate bursts above this, and the
  // cap protects against credential-stuffing, webhook floods, and accidental
  // client-side polling loops.  `/health` and `/api/client-config` are
  // allow-listed so external monitors don't get throttled.
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/api/client-config',
    errorResponseBuilder: (_req, context) => {
      const retryAfter = Math.ceil(context.ttl / 1000);
      return {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        hint: `Retry after ${retryAfter} seconds.`,
        // Numeric convenience field for programmatic clients; the
        // RFC-standard `Retry-After` header is still set by the plugin.
        retryAfter,
      };
    },
  });

  // Register the global error handler before any routes so it catches
  // ApiError / Zod / Fastify validation / unknown errors thrown anywhere
  // in the request pipeline and serializes the canonical envelope.
  await fastify.register(errorHandlerPlugin);

  // Register OpenAPI spec + Swagger UI before routes so it can observe
  // route schemas during registration. Serves /openapi.json and /api/docs.
  await fastify.register(openapiPlugin);

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

  // API routes — single source of truth shared with the spec dumper and tests.
  await registerApiRoutes(fastify);

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

  // Global error handler is registered above via errorHandlerPlugin.

  // Serve static files in production
  if (config.NODE_ENV === 'production') {
    await fastify.register(fastifyStatic, {
      root: join(__dirname, '../ui/dist'),
      prefix: '/',
    });

    // SPA fallback. API 404s use the canonical envelope; everything else
    // falls through to the SPA shell so client-side routing works.
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found' });
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
    // Drain any pending notification fan-out jobs (bounded so a stuck consumer
    // doesn't block shutdown). Must run before disconnectDatabase() because
    // the consumer writes notification rows.
    await flushNotificationQueue(5000);
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

    console.log(`🚀 BRIDGEPORT running at http://${config.HOST}:${config.PORT}`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
