import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../plugins/authorize.js';
import { routeSchema } from '../../lib/openapi-schema.js';
import { logAudit, actorFrom } from '../../services/audit.js';
import {
  captureException,
  flushSentry,
  getSentryStatus,
  isBackendSentryConfigured,
} from '../../lib/sentry.js';

export async function sentryAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // Admin-only because the response discloses which DSNs are configured.
  fastify.get(
    '/api/admin/sentry/status',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Get Sentry configuration status',
        errors: [401, 403],
      }),
    },
    async () => getSentryStatus()
  );

  // Flush before responding so the response reflects whether the event
  // actually left the process.
  fastify.post(
    '/api/admin/sentry/test/backend',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Send a test event to backend Sentry',
        errors: [400, 401, 403],
      }),
    },
    async (request, reply) => {
      if (!isBackendSentryConfigured()) {
        return reply.code(400).send({
          error: 'Backend Sentry is not configured. Set SENTRY_BACKEND_DSN and restart.',
        });
      }

      captureException(new Error('BRIDGEPORT backend Sentry test'), {
        triggeredBy: request.authUser?.email,
        source: 'admin_test_button',
      });
      await flushSentry(2000);

      await logAudit({
        action: 'test',
        resourceType: 'sentry_config',
        resourceId: 'backend',
        ...actorFrom(request),
      });

      return { ok: true, message: 'Test event sent. Check Sentry Issues in ~30s.' };
    }
  );
}
