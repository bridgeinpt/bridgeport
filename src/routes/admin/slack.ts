import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../../plugins/authorize.js';
import {
  listSlackChannels,
  getSlackChannel,
  createSlackChannel,
  updateSlackChannel,
  deleteSlackChannel,
  listSlackRoutings,
  updateRoutingsForType,
  deleteSlackRouting,
  testSlackChannel,
} from '../../services/slack-notifications.js';
import { logAudit } from '../../services/audit.js';

const createChannelSchema = z.object({
  name: z.string().min(1).max(100),
  slackChannelName: z.string().max(100).optional(),
  webhookUrl: z.string().url().refine(
    (url) => url.includes('hooks.slack.com'),
    { message: 'Must be a valid Slack webhook URL' }
  ),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slackChannelName: z.string().max(100).optional(),
  webhookUrl: z.string().url().refine(
    (url) => url.includes('hooks.slack.com'),
    { message: 'Must be a valid Slack webhook URL' }
  ).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const updateRoutingsSchema = z.object({
  typeId: z.string(),
  routings: z.array(z.object({
    channelId: z.string(),
    environmentIds: z.array(z.string()).optional().nullable(),
  })),
});

export async function slackAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // ==================== Channel Endpoints ====================

  // List all Slack channels
  fastify.get(
    '/api/admin/slack/channels',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const channels = await listSlackChannels();
      return { channels };
    }
  );

  // Get single Slack channel
  fastify.get(
    '/api/admin/slack/channels/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const channel = await getSlackChannel(id);

      if (!channel) {
        return reply.code(404).send({ error: 'Slack channel not found' });
      }

      return { channel };
    }
  );

  // Create Slack channel
  fastify.post(
    '/api/admin/slack/channels',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createChannelSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const channel = await createSlackChannel(body.data);

      await logAudit({
        action: 'create',
        resourceType: 'slack_channel',
        resourceId: channel.id,
        resourceName: channel.name,
        details: { slackChannelName: channel.slackChannelName },
        userId: request.authUser!.id,
      });

      return { channel };
    }
  );

  // Update Slack channel
  fastify.put(
    '/api/admin/slack/channels/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateChannelSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const channel = await updateSlackChannel(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'slack_channel',
          resourceId: channel.id,
          resourceName: channel.name,
          details: body.data,
          userId: request.authUser!.id,
        });

        return { channel };
      } catch {
        return reply.code(404).send({ error: 'Slack channel not found' });
      }
    }
  );

  // Delete Slack channel
  fastify.delete(
    '/api/admin/slack/channels/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const channel = await getSlackChannel(id);
      if (!channel) {
        return reply.code(404).send({ error: 'Slack channel not found' });
      }

      await deleteSlackChannel(id);

      await logAudit({
        action: 'delete',
        resourceType: 'slack_channel',
        resourceId: id,
        resourceName: channel.name,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Test Slack channel
  fastify.post(
    '/api/admin/slack/channels/:id/test',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await testSlackChannel(id);

      if (!result.success) {
        return reply.code(400).send({
          success: false,
          error: result.error || 'Test failed',
        });
      }

      return { success: true, message: 'Test message sent to Slack successfully' };
    }
  );

  // ==================== Routing Endpoints ====================

  // Get all routing configurations
  fastify.get(
    '/api/admin/slack/routing',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const routings = await listSlackRoutings();
      return { routings };
    }
  );

  // Update routings for a notification type
  fastify.put(
    '/api/admin/slack/routing',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = updateRoutingsSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const routings = await updateRoutingsForType(body.data.typeId, body.data.routings);

      await logAudit({
        action: 'update',
        resourceType: 'slack_routing',
        resourceId: body.data.typeId,
        details: { routingCount: routings.length },
        userId: request.authUser!.id,
      });

      return { routings };
    }
  );

  // Delete a specific routing
  fastify.delete(
    '/api/admin/slack/routing/:typeId/:channelId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { typeId, channelId } = request.params as { typeId: string; channelId: string };

      try {
        await deleteSlackRouting(typeId, channelId);

        await logAudit({
          action: 'delete',
          resourceType: 'slack_routing',
          resourceId: `${typeId}:${channelId}`,
          userId: request.authUser!.id,
        });

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Routing not found' });
      }
    }
  );
}
