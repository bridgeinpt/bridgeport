import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../plugins/authorize.js';
import { logAudit, actorFrom } from '../../services/audit.js';
import { captureException, flushSentry } from '../../lib/sentry.js';
import { config } from '../../lib/config.js';

export async function sentryAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // Report which Sentry DSNs are configured so the UI can show the right
  // setup/test affordances. Admin-only because it discloses configuration.
  fastify.get(
    '/api/admin/sentry/status',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const enabled = config.SENTRY_ENABLED;
      return {
        enabled,
        backendConfigured: enabled && !!config.SENTRY_BACKEND_DSN,
        frontendConfigured: enabled && !!config.SENTRY_FRONTEND_DSN,
        environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
      };
    }
  );

  // Capture a synthetic exception so the admin can confirm backend Sentry
  // delivery end-to-end. Flushes before responding so the response reflects
  // whether the event actually left the process.
  fastify.post(
    '/api/admin/sentry/test/backend',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      if (!config.SENTRY_ENABLED || !config.SENTRY_BACKEND_DSN) {
        return reply.code(400).send({
          error: 'Backend Sentry is not configured. Set SENTRY_BACKEND_DSN and restart.',
        });
      }

      const testError = new Error('BRIDGEPORT backend Sentry test');
      captureException(testError, {
        triggeredBy: request.authUser?.email,
        source: 'admin_test_button',
      });
      await flushSentry(5000);

      await logAudit({
        action: 'test',
        resourceType: 'sentry_backend',
        ...actorFrom(request),
      });

      return { ok: true, message: 'Test event sent. Check Sentry Issues in ~30s.' };
    }
  );
}
