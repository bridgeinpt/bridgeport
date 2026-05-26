import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { prisma } from '../lib/db.js';
import {
  getModuleSettings,
  updateModuleSettings,
  resetModuleSettings,
  SETTINGS_REGISTRY,
  type SettingsModule,
} from '../services/environment-settings.js';
import { findOrNotFound, getErrorMessage, validateBody } from '../lib/helpers.js';
import { testSlackChannel } from '../services/slack-notifications.js';

const VALID_MODULES = ['general', 'monitoring', 'operations', 'data', 'configuration'] as const;

const updateNotificationSettingsSchema = z.object({
  // null clears the override; string sets it.
  slackChannelId: z.string().nullable().optional(),
});

function isValidModule(value: string): value is SettingsModule {
  return (VALID_MODULES as readonly string[]).includes(value);
}

export async function environmentSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/environments/:id/settings/registry
  fastify.get(
    '/api/environments/:id/settings/registry',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      return { registry: SETTINGS_REGISTRY };
    },
  );

  // GET /api/environments/:id/settings/:module
  fastify.get(
    '/api/environments/:id/settings/:module',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const settings = await getModuleSettings(id, module);
      const definitions = SETTINGS_REGISTRY[module];

      return { settings, definitions };
    },
  );

  // PATCH /api/environments/:id/settings/:module
  fastify.patch(
    '/api/environments/:id/settings/:module',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      try {
        const { updated, changes } = await updateModuleSettings(id, module, request.body as Record<string, unknown>);

        if (changes.length > 0) {
          await logAudit({
            action: 'update',
            resourceType: 'environment',
            resourceId: id,
            resourceName: env.name,
            details: { module, changes },
            ...actorFrom(request),
            environmentId: id,
          });
        }

        return { settings: updated };
      } catch (err) {
        const message = getErrorMessage(err, 'Validation failed');
        return reply.code(400).send({ error: message });
      }
    },
  );

  // POST /api/environments/:id/settings/:module/reset
  fastify.post(
    '/api/environments/:id/settings/:module/reset',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const settings = await resetModuleSettings(id, module);

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: env.name,
        details: { module, reset: true },
        ...actorFrom(request),
        environmentId: id,
      });

      return { settings };
    },
  );

  // ==================== Notification Settings (bespoke) ====================
  //
  // Lives outside the per-module settings registry because the field's options
  // (available Slack channels) are dynamic and need to be returned alongside
  // the current value so the UI can render an "Inherits default" hint.

  // GET /api/environments/:id/settings/notifications
  fastify.get(
    '/api/environments/:id/settings/notifications',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const [settings, channels, defaultChannel] = await Promise.all([
        prisma.notificationSettings.findUnique({
          where: { environmentId: id },
          select: { slackChannelId: true, updatedAt: true },
        }),
        prisma.slackChannel.findMany({
          where: { enabled: true },
          select: { id: true, name: true, slackChannelName: true, isDefault: true },
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        }),
        prisma.slackChannel.findFirst({
          where: { isDefault: true, enabled: true },
          select: { id: true, name: true, slackChannelName: true },
        }),
      ]);

      // If the persisted override points at a channel that's been disabled
      // (or deleted), it won't appear in the `channels` list above. Surface
      // it explicitly so the UI can show a "(disabled)" hint and let the
      // admin clear or reassign it instead of silently hiding the state.
      let selectedChannel: { id: string; name: string; slackChannelName: string | null; enabled: boolean } | null = null;
      if (settings?.slackChannelId && !channels.some((c) => c.id === settings.slackChannelId)) {
        const dangling = await prisma.slackChannel.findUnique({
          where: { id: settings.slackChannelId },
          select: { id: true, name: true, slackChannelName: true, enabled: true },
        });
        if (dangling) {
          selectedChannel = dangling;
        }
      }

      return {
        settings: {
          slackChannelId: settings?.slackChannelId ?? null,
          updatedAt: settings?.updatedAt ?? null,
        },
        channels,
        defaultChannel,
        selectedChannel,
      };
    },
  );

  // PATCH /api/environments/:id/settings/notifications
  fastify.patch(
    '/api/environments/:id/settings/notifications',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateNotificationSettingsSchema, request, reply);
      if (!body) return;

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      // When the caller sets a channel, make sure it exists AND is enabled.
      // Persisting a pointer to a disabled channel would cause
      // dispatchSlackNotification to silently skip notifications later.
      // Distinguish "not found" from "disabled" so the UI can show a clearer error.
      // Null clears the override.
      if (body.slackChannelId) {
        const channel = await prisma.slackChannel.findUnique({
          where: { id: body.slackChannelId },
          select: { id: true, enabled: true },
        });
        if (!channel) {
          return reply.code(400).send({ error: 'Slack channel not found' });
        }
        if (!channel.enabled) {
          return reply.code(400).send({ error: 'Slack channel is disabled' });
        }
      }

      const previous = await prisma.notificationSettings.findUnique({
        where: { environmentId: id },
        select: { slackChannelId: true },
      });

      const settings = await prisma.notificationSettings.upsert({
        where: { environmentId: id },
        create: { environmentId: id, slackChannelId: body.slackChannelId ?? null },
        update: { slackChannelId: body.slackChannelId ?? null },
        select: { slackChannelId: true, updatedAt: true },
      });

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: env.name,
        details: {
          module: 'notifications',
          changes: [
            {
              key: 'slackChannelId',
              from: previous?.slackChannelId ?? null,
              to: settings.slackChannelId,
            },
          ],
        },
        ...actorFrom(request),
        environmentId: id,
      });

      return { settings };
    },
  );

  // POST /api/environments/:id/settings/notifications/test
  // Send a test Slack message via the env's overridden channel (or, when no
  // override is set, the global default). Mirrors /api/admin/slack/channels/:id/test
  // but resolves the channel from environment context.
  fastify.post(
    '/api/environments/:id/settings/notifications/test',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const settings = await prisma.notificationSettings.findUnique({
        where: { environmentId: id },
        select: { slackChannelId: true },
      });

      // Mirror dispatchSlackNotification: only use the override when it
      // resolves to an enabled channel. Otherwise fall through to the
      // global default — sending through a disabled override would diverge
      // from real notification behavior.
      let resolved: { id: string; name: string; isDefault: boolean } | null = null;
      let source: 'override' | 'default' = 'default';
      if (settings?.slackChannelId) {
        const overrideChannel = await prisma.slackChannel.findFirst({
          where: { id: settings.slackChannelId, enabled: true },
          select: { id: true, name: true, isDefault: true },
        });
        if (overrideChannel) {
          resolved = overrideChannel;
          source = 'override';
        }
      }
      if (!resolved) {
        const fallback = await prisma.slackChannel.findFirst({
          where: { isDefault: true, enabled: true },
          select: { id: true, name: true, isDefault: true },
        });
        if (!fallback) {
          return reply.code(400).send({
            error: 'No Slack channel configured for this environment and no default channel is set.',
          });
        }
        resolved = fallback;
        source = 'default';
      }

      const result = await testSlackChannel(resolved.id);
      if (!result.success) {
        return reply.code(400).send({ success: false, error: result.error || 'Test failed' });
      }

      return {
        success: true,
        channelId: resolved.id,
        usedChannel: { id: resolved.id, name: resolved.name, source },
      };
    },
  );
}
