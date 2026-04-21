import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../../plugins/authorize.js';
import { validateBody, findOrNotFound } from '../../lib/helpers.js';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
} from '../../services/outgoing-webhooks.js';
import { logAudit } from '../../services/audit.js';

const createWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  typeFilter: z.array(z.string()).optional(),
  environmentIds: z.array(z.string()).optional(),
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  secret: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  typeFilter: z.array(z.string()).optional(),
  environmentIds: z.array(z.string()).optional(),
});

export async function webhookAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // List all webhooks
  fastify.get(
    '/api/admin/webhooks',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const webhooks = await listWebhooks();
      return { webhooks };
    }
  );

  // Get single webhook
  fastify.get(
    '/api/admin/webhooks/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const webhook = await findOrNotFound(getWebhook(id), 'Webhook', reply);
      if (!webhook) return;

      return { webhook };
    }
  );

  // Create webhook
  fastify.post(
    '/api/admin/webhooks',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = validateBody(createWebhookSchema, request, reply);
      if (!body) return;

      const webhook = await createWebhook(body);

      await logAudit({
        action: 'create',
        resourceType: 'webhook_config',
        resourceId: webhook.id,
        resourceName: webhook.name,
        details: { url: webhook.url },
        userId: request.authUser!.id,
      });

      return { webhook };
    }
  );

  // Update webhook
  fastify.put(
    '/api/admin/webhooks/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateWebhookSchema, request, reply);
      if (!body) return;

      try {
        const webhook = await updateWebhook(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'webhook_config',
          resourceId: webhook.id,
          resourceName: webhook.name,
          details: body,
          userId: request.authUser!.id,
        });

        return { webhook };
      } catch {
        return reply.code(404).send({ error: 'Webhook not found' });
      }
    }
  );

  // Delete webhook
  fastify.delete(
    '/api/admin/webhooks/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const webhook = await findOrNotFound(getWebhook(id), 'Webhook', reply);
      if (!webhook) return;

      await deleteWebhook(id);

      await logAudit({
        action: 'delete',
        resourceType: 'webhook_config',
        resourceId: id,
        resourceName: webhook.name,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Test webhook
  fastify.post(
    '/api/admin/webhooks/:id/test',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await testWebhook(id);

      if (!result.success) {
        return reply.code(400).send({ error: result.error || 'Test failed' });
      }

      return { success: true, message: 'Test webhook sent successfully' };
    }
  );
}
