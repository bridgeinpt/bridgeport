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
import idempotencyPlugin from '../../src/lib/idempotency.js';
import errorHandlerPlugin from '../../src/plugins/error-handler.js';
import openapiPlugin from '../../src/plugins/openapi.js';
// SINGLE SOURCE OF TRUTH for the route set — shared with src/server.ts and the
// spec dumper, so the test app exercises exactly the routes that ship.
import { registerApiRoutes } from '../../src/register-routes.js';

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

  // Mirror production (src/server.ts): route `schema` options are attached for
  // OpenAPI docs only — runtime validation stays with Zod. A no-op validator
  // compiler keeps Fastify from validating (and Ajv-compiling) those schemas.
  fastify.setValidatorCompiler(() => () => true);

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

  // Match production: error handler + openapi must run before routes so the
  // canonical error envelope and the spec both observe everything that
  // follows. Tests therefore exercise the real error wire shape, not a
  // legacy `{error: ...}` body.
  await fastify.register(errorHandlerPlugin);
  await fastify.register(openapiPlugin);

  await fastify.register(authenticatePlugin);
  // Idempotency-Key hooks (issue #126) — mirror server.ts so tests exercise the
  // same pipeline. No-op unless a POST carries an Idempotency-Key header.
  await fastify.register(idempotencyPlugin);
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Register all API routes — single source of truth shared with the server
  // and the spec dumper (this now includes configScanRoutes, which the old
  // hand-copied list omitted).
  await registerApiRoutes(fastify);

  // Health check endpoint
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: 'test',
  }));

  // Error handler is provided by errorHandlerPlugin above (canonical envelope).

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
