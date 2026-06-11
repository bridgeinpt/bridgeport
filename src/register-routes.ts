/**
 * SINGLE SOURCE OF TRUTH for API route registration.
 *
 * Both the production server (`src/server.ts`), the test app builder
 * (`tests/helpers/app.ts`), and the OpenAPI spec dumper (`scripts/openapi-dump.ts`)
 * call this function so they register the EXACT SAME set of routes IN THE SAME
 * ORDER. Previously each maintained its own hand-copied `fastify.register(...)`
 * list, which drifted (the test app even omitted `configScanRoutes`) and could
 * silently drop a new route from the published spec while the drift check stayed
 * green.
 *
 * IMPORTANT: this registers API route plugins ONLY. The openapi plugin (which
 * must run BEFORE routes so it observes their schemas), the error handler, auth
 * decorators, the no-op validator compiler, the JSON content-type parser, and
 * the inline `/health` and `/api/client-config` routes stay in their respective
 * callers — they are infrastructure, not API surface, and their order relative
 * to the openapi plugin must be preserved by the caller.
 *
 * To add a new API route: add it here (in the appropriate position) and it is
 * picked up everywhere automatically.
 */
import type { FastifyInstance } from 'fastify';

import { authRoutes } from './routes/auth.js';
import { environmentRoutes } from './routes/environments.js';
import { serverRoutes } from './routes/servers.js';
import { serviceRoutes } from './routes/services.js';
import { secretRoutes } from './routes/secrets.js';
import { webhookRoutes } from './routes/webhooks.js';
import { composeRoutes } from './routes/compose.js';
import { auditRoutes } from './routes/audit.js';
import { configFileRoutes } from './routes/config-files.js';
import { configFragmentRoutes } from './routes/config-fragments.js';
import { registryRoutes } from './routes/registries.js';
import { userRoutes } from './routes/users.js';
import { metricsRoutes } from './routes/metrics.js';
import { databaseRoutes } from './routes/databases.js';
import { notificationRoutes } from './routes/notifications.js';
import { smtpRoutes } from './routes/admin/smtp.js';
import { webhookAdminRoutes } from './routes/admin/webhooks.js';
import { slackAdminRoutes } from './routes/admin/slack.js';
import { sentryAdminRoutes } from './routes/admin/sentry.js';
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
import { configScanRoutes } from './routes/config-scan.js';
import { serviceAccountRoutes } from './routes/service-accounts.js';
import { apiTokenRoutes } from './routes/api-tokens.js';
import { syncBatchRoutes } from './routes/sync-batch.js';
import { webhookSubscriptionRoutes } from './routes/webhook-subscriptions.js';

/**
 * Register every API route plugin on the given Fastify instance, in the
 * canonical order. The openapi plugin MUST already be registered so it observes
 * each route's `schema`.
 */
export async function registerApiRoutes(fastify: FastifyInstance): Promise<void> {
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
  await fastify.register(webhookSubscriptionRoutes);
}
