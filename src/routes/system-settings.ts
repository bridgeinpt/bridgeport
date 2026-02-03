import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getSystemSettings,
  updateSystemSettings,
  resetSystemSettings,
  SYSTEM_SETTINGS_DEFAULTS,
} from '../services/system-settings.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';

const updateSettingsSchema = z.object({
  sshCommandTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  sshReadyTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  webhookMaxRetries: z.number().int().min(0).max(10).optional(),
  webhookTimeoutMs: z.number().int().min(1000).max(300000).optional(),
  webhookRetryDelaysMs: z.string().optional(), // JSON array string
  pgDumpTimeoutMs: z.number().int().min(30000).max(3600000).optional(),
  maxUploadSizeMb: z.number().int().min(1).max(500).optional(),
  activeUserWindowMin: z.number().int().min(1).max(1440).optional(),
  registryMaxTags: z.number().int().min(10).max(500).optional(),
  defaultLogLines: z.number().int().min(10).max(10000).optional(),
});

export async function systemSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get current system settings (all authenticated users)
  fastify.get(
    '/api/settings/system',
    { preHandler: [fastify.authenticate] },
    async () => {
      const settings = await getSystemSettings();
      return {
        settings,
        defaults: SYSTEM_SETTINGS_DEFAULTS,
      };
    }
  );

  // Update system settings (admin only)
  fastify.put(
    '/api/settings/system',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = updateSettingsSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Validate webhookRetryDelaysMs is valid JSON array if provided
      if (body.data.webhookRetryDelaysMs) {
        try {
          const delays = JSON.parse(body.data.webhookRetryDelaysMs);
          if (!Array.isArray(delays) || !delays.every(d => typeof d === 'number' && d >= 0)) {
            return reply.code(400).send({
              error: 'webhookRetryDelaysMs must be a JSON array of non-negative numbers',
            });
          }
        } catch {
          return reply.code(400).send({
            error: 'webhookRetryDelaysMs must be valid JSON',
          });
        }
      }

      const settings = await updateSystemSettings(body.data);

      await logAudit({
        action: 'update',
        resourceType: 'system_settings',
        resourceId: 'singleton',
        resourceName: 'System Settings',
        details: { changes: body.data },
        userId: request.authUser!.id,
      });

      return { settings };
    }
  );

  // Reset system settings to defaults (admin only)
  fastify.post(
    '/api/settings/system/reset',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request) => {
      const settings = await resetSystemSettings();

      await logAudit({
        action: 'update',
        resourceType: 'system_settings',
        resourceId: 'singleton',
        resourceName: 'System Settings',
        details: { action: 'reset_to_defaults' },
        userId: request.authUser!.id,
      });

      return { settings, message: 'Settings reset to defaults' };
    }
  );
}
