/**
 * Env-scoped webhook subscription endpoints (issue #126).
 *
 * Mounted under `/api/environments/:envId/webhooks` so env-scoped API tokens are
 * permitted (the authenticate plugin denies env-scoped tokens on non-env paths).
 * This is the management surface for the WebhookSubscription system — a SEPARATE
 * system from the admin-scoped WebhookConfig (`/api/admin/webhooks`).
 *
 * Routes:
 *   POST   /api/environments/:envId/webhooks               (operator+) create
 *   GET    /api/environments/:envId/webhooks               (viewer+)   list
 *   GET    /api/environments/:envId/webhooks/:id           (viewer+)   get one
 *   DELETE /api/environments/:envId/webhooks/:id           (operator+) delete
 *   GET    /api/environments/:envId/webhooks/:id/deliveries (viewer+)  history
 *
 * The signing secret is write-only: it is encrypted at rest and NEVER returned
 * in any response (only `hasSecret: boolean` is surfaced).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookDeliveries,
  areValidEvents,
  WEBHOOK_EVENTS,
} from '../services/webhook-subscriptions.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { requireOperator } from '../plugins/authorize.js';
import { validateBody, parsePaginationQuery, getErrorMessage } from '../lib/helpers.js';
import { routeSchema, paginationQuerySchema } from '../lib/openapi-schema.js';

const envIdParamsSchema = z.object({ envId: z.string() });
const webhookParamsSchema = z.object({ envId: z.string(), id: z.string() });

const createSubscriptionSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().optional(),
});

export async function webhookSubscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  // Create a subscription (operator+).
  fastify.post(
    '/api/environments/:envId/webhooks',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['webhooks'],
        summary: 'Create an env-scoped webhook subscription',
        params: envIdParamsSchema,
        body: createSubscriptionSchema,
        errors: [400, 401, 403],
      }),
    },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createSubscriptionSchema, request, reply);
      if (!body) return;

      // Defense-in-depth: the Zod enum already constrains events, but re-check
      // against the canonical set so the rule lives in one place.
      if (!areValidEvents(body.events)) {
        return reply.code(400).send({ error: 'Invalid event code(s)' });
      }

      let subscription;
      try {
        subscription = await createWebhookSubscription(envId, body);
      } catch (err) {
        // SSRF guard (and any other create-time validation) → 400.
        return reply.code(400).send({ error: getErrorMessage(err, 'Invalid webhook subscription') });
      }

      await logAudit({
        action: 'create',
        resourceType: 'webhook_subscription',
        resourceId: subscription.id,
        resourceName: subscription.url,
        details: { events: subscription.events, enabled: subscription.enabled },
        ...actorFrom(request),
        environmentId: envId,
      });

      reply.code(201);
      return { subscription };
    }
  );

  // List subscriptions for the environment (viewer+).
  fastify.get(
    '/api/environments/:envId/webhooks',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['webhooks'],
        summary: 'List env-scoped webhook subscriptions',
        params: envIdParamsSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const subscriptions = await listWebhookSubscriptions(envId);
      return { subscriptions };
    }
  );

  // Get a single subscription (viewer+).
  fastify.get(
    '/api/environments/:envId/webhooks/:id',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['webhooks'],
        summary: 'Get a single env-scoped webhook subscription',
        params: webhookParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };
      const subscription = await getWebhookSubscription(envId, id);
      if (!subscription) {
        return reply.code(404).send({ error: 'Webhook subscription not found' });
      }
      return { subscription };
    }
  );

  // Delete a subscription (operator+).
  fastify.delete(
    '/api/environments/:envId/webhooks/:id',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['webhooks'],
        summary: 'Delete an env-scoped webhook subscription',
        params: webhookParamsSchema,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };
      const deleted = await deleteWebhookSubscription(envId, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Webhook subscription not found' });
      }

      await logAudit({
        action: 'delete',
        resourceType: 'webhook_subscription',
        resourceId: id,
        ...actorFrom(request),
        environmentId: envId,
      });

      return { success: true };
    }
  );

  // Paginated delivery history for a subscription (viewer+).
  fastify.get(
    '/api/environments/:envId/webhooks/:id/deliveries',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['webhooks'],
        summary: 'List delivery history for a webhook subscription',
        params: webhookParamsSchema,
        querystring: paginationQuerySchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };

      // Verify the subscription exists in this environment before exposing its
      // deliveries (avoids leaking cross-env delivery rows).
      const subscription = await getWebhookSubscription(envId, id);
      if (!subscription) {
        return reply.code(404).send({ error: 'Webhook subscription not found' });
      }

      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);
      const result = await listWebhookDeliveries(id, { limit, offset });
      return { ...result, limit, offset };
    }
  );
}
