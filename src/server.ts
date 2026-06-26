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
import idempotencyPlugin from './lib/idempotency.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import openapiPlugin from './plugins/openapi.js';
import { registerApiRoutes } from './register-routes.js';
import mcpPlugin from './mcp/plugin.js';
import { bootstrapAdminUser } from './services/auth.js';
import { bootstrapManagementEnvironment } from './services/host-detection.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { initializeNotificationTypes } from './services/notifications.js';
import { flushNotificationQueue } from './services/notification-queue.js';
import { syncPlugins } from './services/plugin-loader.js';
import { getSystemSettings } from './services/system-settings.js';
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

  // Global rate limiting — defaults to 100 requests/minute per client IP
  // (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW). The cap protects the *programmatic*
  // surface (`/api/*`, `/mcp`) against credential-stuffing, webhook floods, and
  // accidental client-side polling loops.
  //
  // It deliberately does NOT cover static asset serving or the SPA shell: a
  // single page load pulls `index.html` + a dozen hashed JS/CSS chunks, and
  // monitoring pages poll every 30s, so one legitimate user trivially exceeds
  // the per-IP budget. Throttling those requests broke the UI — the browser's
  // lazy-import fetch for a route chunk 404s on a 429 ("Failed to fetch
  // dynamically imported module"), and the rate-limit error raised on the
  // `@fastify/static` wildcard route was mis-reported as a 500 (its
  // errorHandler delegates to our global handler). Static file serving is best
  // DoS-protected at the reverse proxy / CDN layer, not here.
  //
  // `/health` and `/api/client-config` stay exempt so external monitors and the
  // frontend bootstrap aren't throttled.
  await fastify.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    allowList: (req) => {
      if (req.url === '/health' || req.url === '/api/client-config') return true;
      // Strip the query string before matching the path.
      const path = req.url.split('?', 1)[0];
      // Keep the programmatic surface throttled; everything else is static
      // assets / the SPA shell, which are GET/HEAD-only and safe to exempt.
      if (path.startsWith('/api/') || path === '/mcp') return false;
      return req.method === 'GET' || req.method === 'HEAD';
    },
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

  // Idempotency-Key support for mutating POSTs (issue #126). This is a GLOBAL
  // preHandler that runs BEFORE the route-level `fastify.authenticate`, so it
  // has no `request.authUser`. To keep keys from colliding across tenants, the
  // stored key folds in a hash of the request credential (Authorization/Cookie
  // header) — see lib/idempotency.ts. Engages only when the Idempotency-Key
  // header is present, so it's a no-op for every other request.
  await fastify.register(idempotencyPlugin);

  // Max upload size is read once at boot from system settings (default 50MB);
  // changing it requires a restart (Pass 5 surfaces a "requires restart" badge).
  const systemSettings = await getSystemSettings();
  await fastify.register(multipart, {
    limits: {
      fileSize: systemSettings.maxUploadSizeMb * 1024 * 1024,
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

  // MCP (Model Context Protocol) server — exposes a curated subset of the API
  // as agent tools at POST /mcp. Opt-in via MCP_ENABLED (default false); when
  // off the route is never registered, so /mcp returns 404. The plugin mounts
  // on the ROOT instance because its tool handlers replay calls through
  // `app.inject()`. NOTE: injected calls intentionally stay subject to the
  // normal per-IP rate limit — and each is attributed to the MCP caller's real
  // IP (threaded through as `remoteAddress`; see src/mcp/inject.ts), so a
  // caller's tool calls bucket under their own IP exactly like their direct API
  // calls. We do NOT add /mcp (or a bypass header) to the rate-limit allowList,
  // since a static bypass would be spoofable on every route and defeat login
  // rate-limiting.
  if (config.MCP_ENABLED) {
    await fastify.register(mcpPlugin);
  }

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
      databaseMetricsIntervalMs: config.SCHEDULER_DATABASE_METRICS_INTERVAL * 1000,
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
