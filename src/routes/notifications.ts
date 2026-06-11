import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  list,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getPreferences,
  updatePreference,
  listNotificationTypes,
  updateNotificationType,
} from '../services/notifications.js';
import { requireAdmin } from '../plugins/authorize.js';
import { validateBody, findOrNotFound } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

const idParamSchema = z.object({ id: z.string() });
const typeIdParamSchema = z.object({ typeId: z.string() });

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  unreadOnly: z.coerce.boolean().default(false),
  environmentId: z.string().optional(),
  category: z.enum(['user', 'system']).optional(),
});

const updatePreferenceSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  webhookEnabled: z.boolean().optional(),
  environmentIds: z.array(z.string()).nullable().optional(),
});

const updateTypeSchema = z.object({
  defaultChannels: z.array(z.enum(['in_app', 'email', 'webhook'])).optional(),
  enabled: z.boolean().optional(),
  bounceEnabled: z.boolean().optional(),
  bounceThreshold: z.number().min(1).max(100).optional(),
  bounceCooldown: z.number().min(60).max(86400).optional(),
});

export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  // List notifications for current user
  fastify.get(
    '/api/notifications',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'List notifications for the current user',
        querystring: listQuerySchema,
        errors: [401],
      }),
    },
    async (request) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return { notifications: [], total: 0 };
      }

      return list(request.authUser!.id, query.data);
    }
  );

  // Get unread count for current user
  fastify.get(
    '/api/notifications/unread-count',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'Get the unread notification count for the current user',
        errors: [401],
      }),
    },
    async (request) => {
      const count = await getUnreadCount(request.authUser!.id);
      return { count };
    }
  );

  // Mark notification as read
  fastify.post(
    '/api/notifications/:id/read',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'Mark a notification as read',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const notification = await findOrNotFound(markAsRead(id, request.authUser!.id), 'Notification', reply);
      if (!notification) return;

      return { notification };
    }
  );

  // Mark all notifications as read
  fastify.post(
    '/api/notifications/read-all',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'Mark all notifications as read for the current user',
        errors: [401],
      }),
    },
    async (request) => {
      const count = await markAllAsRead(request.authUser!.id);
      return { count };
    }
  );

  // Get notification preferences for current user
  fastify.get(
    '/api/notifications/preferences',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'Get notification preferences for the current user',
        errors: [401],
      }),
    },
    async (request) => {
      const preferences = await getPreferences(request.authUser!.id);
      return { preferences };
    }
  );

  // Update notification preference for a specific type
  fastify.put(
    '/api/notifications/preferences/:typeId',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        summary: 'Update the current user\'s preference for a notification type',
        params: typeIdParamSchema,
        body: updatePreferenceSchema,
        errors: [400, 401],
      }),
    },
    async (request, reply) => {
      const { typeId } = request.params as { typeId: string };
      const body = validateBody(updatePreferenceSchema, request, reply);
      if (!body) return;

      const preference = await updatePreference(request.authUser!.id, typeId, body);
      return { preference };
    }
  );

  // === Admin routes ===

  // List all notification types (admin only)
  fastify.get(
    '/api/admin/notification-types',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'List all notification types (admin only)',
        errors: [401, 403],
      }),
    },
    async () => {
      const types = await listNotificationTypes();
      return { types };
    }
  );

  // Update notification type settings (admin only)
  fastify.put(
    '/api/admin/notification-types/:id',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Update notification type settings (admin only)',
        params: idParamSchema,
        body: updateTypeSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateTypeSchema, request, reply);
      if (!body) return;

      try {
        const notificationType = await updateNotificationType(id, body);
        return { type: notificationType };
      } catch {
        return reply.code(404).send({ error: 'Notification type not found' });
      }
    }
  );
}
