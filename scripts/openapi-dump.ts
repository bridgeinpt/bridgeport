/**
 * Generate the checked-in `openapi.json` snapshot from the live route schemas.
 *
 * The spec is the single source of truth derived from the EXISTING Zod
 * validation schemas (wired in via `src/lib/openapi-schema.ts`). This script
 * builds a Fastify instance port-less — registering the same plugins and routes
 * as `src/server.ts` but WITHOUT a database, scheduler, signal handlers, or a
 * listening socket — then writes `app.swagger()` to `openapi.json` at the repo
 * root.
 *
 * Run:
 *   npm run openapi:dump    # regenerate the snapshot
 *   npm run openapi:check   # regenerate + fail if it drifted from git
 *
 * Determinism: the OpenAPI `info.version` is pinned to a stable literal in
 * src/plugins/openapi.ts so the snapshot is byte-identical across builds and
 * the drift check never trips on the git/build version stamp.
 */
// MUST be the first import: sets env defaults the config loader requires before
// any module reading `src/lib/config.ts` is evaluated (ESM runs imports in order).
import './openapi-env.js';

import Fastify from 'fastify';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initializeCrypto } from '../src/lib/crypto.js';
import errorHandlerPlugin from '../src/plugins/error-handler.js';
import openapiPlugin from '../src/plugins/openapi.js';
import authenticatePlugin from '../src/plugins/authenticate.js';

// Route imports — kept in sync with src/server.ts registration.
import { authRoutes } from '../src/routes/auth.js';
import { environmentRoutes } from '../src/routes/environments.js';
import { serverRoutes } from '../src/routes/servers.js';
import { serviceRoutes } from '../src/routes/services.js';
import { secretRoutes } from '../src/routes/secrets.js';
import { webhookRoutes } from '../src/routes/webhooks.js';
import { composeRoutes } from '../src/routes/compose.js';
import { auditRoutes } from '../src/routes/audit.js';
import { configFileRoutes } from '../src/routes/config-files.js';
import { configFragmentRoutes } from '../src/routes/config-fragments.js';
import { registryRoutes } from '../src/routes/registries.js';
import { userRoutes } from '../src/routes/users.js';
import { metricsRoutes } from '../src/routes/metrics.js';
import { databaseRoutes } from '../src/routes/databases.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import { smtpRoutes } from '../src/routes/admin/smtp.js';
import { webhookAdminRoutes } from '../src/routes/admin/webhooks.js';
import { slackAdminRoutes } from '../src/routes/admin/slack.js';
import { sentryAdminRoutes } from '../src/routes/admin/sentry.js';
import { containerImageRoutes } from '../src/routes/container-images.js';
import { serviceDependencyRoutes } from '../src/routes/service-dependencies.js';
import { deploymentPlanRoutes } from '../src/routes/deployment-plans.js';
import { settingsRoutes } from '../src/routes/settings.js';
import { spacesRoutes } from '../src/routes/spaces.js';
import { monitoringRoutes } from '../src/routes/monitoring.js';
import { systemSettingsRoutes } from '../src/routes/system-settings.js';
import { downloadRoutes } from '../src/routes/downloads.js';
import { topologyRoutes } from '../src/routes/topology.js';
import { environmentSettingsRoutes } from '../src/routes/environment-settings.js';
import { eventRoutes } from '../src/routes/events.js';
import { configScanRoutes } from '../src/routes/config-scan.js';
import { serviceAccountRoutes } from '../src/routes/service-accounts.js';
import { apiTokenRoutes } from '../src/routes/api-tokens.js';
import { syncBatchRoutes } from '../src/routes/sync-batch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildSpecApp() {
  // Crypto must be initialized before some service imports run. The key comes
  // from ./openapi-env.js (a valid throwaway key — no secrets are decrypted
  // during a spec dump).
  initializeCrypto(process.env.MASTER_KEY!);

  const fastify = Fastify({ logger: false });

  // Mirror production (src/server.ts): route `schema` options are docs-only;
  // a no-op validator compiler stops Fastify/Ajv from compiling them (Ajv can't
  // parse the OpenAPI 3.0 dialect these schemas use). @fastify/swagger still
  // reads them for the spec.
  fastify.setValidatorCompiler(() => () => true);

  // @fastify/jwt is required by the authenticate plugin's decorator wiring at
  // registration time; register it with a throwaway secret.
  const { default: jwt } = await import('@fastify/jwt');
  await fastify.register(jwt, { secret: process.env.JWT_SECRET || 'openapi-dump-jwt-secret' });

  // Same JSON body parser quirk as production (allows empty bodies).
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (!body || body === '') return done(null, {});
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Order matches production: error handler + openapi before routes so the spec
  // observes every route schema during registration.
  await fastify.register(errorHandlerPlugin);
  await fastify.register(openapiPlugin);
  await fastify.register(authenticatePlugin);

  const { default: multipart } = await import('@fastify/multipart');
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  await fastify.register(authRoutes);
  await fastify.register(environmentRoutes);
  await fastify.register(serverRoutes);
  await fastify.register(serviceRoutes);
  await fastify.register(secretRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(composeRoutes);
  await fastify.register(auditRoutes);
  await fastify.register(configFileRoutes);
  await fastify.register(configFragmentRoutes);
  await fastify.register(registryRoutes);
  await fastify.register(userRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(databaseRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(smtpRoutes);
  await fastify.register(webhookAdminRoutes);
  await fastify.register(slackAdminRoutes);
  await fastify.register(sentryAdminRoutes);
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
  await fastify.register(configScanRoutes);
  await fastify.register(serviceAccountRoutes);
  await fastify.register(apiTokenRoutes);
  await fastify.register(syncBatchRoutes);

  await fastify.ready();
  return fastify;
}

async function main() {
  const app = await buildSpecApp();
  try {
    const spec = app.swagger();
    const outPath = join(__dirname, '..', 'openapi.json');
    await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`Wrote OpenAPI spec to ${outPath}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('openapi-dump failed:', err);
  process.exit(1);
});
