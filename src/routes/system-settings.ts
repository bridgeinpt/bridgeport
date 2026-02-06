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
  publicUrl: z.string().url().nullable().optional().or(z.literal('')),
  agentCallbackUrl: z.string().url().nullable().optional().or(z.literal('')),
  agentStaleThresholdMs: z.number().int().min(60000).max(600000).optional(),
  agentOfflineThresholdMs: z.number().int().min(120000).max(900000).optional(),
  doRegistryToken: z.string().nullable().optional().or(z.literal('')),
  auditLogRetentionDays: z.number().int().min(0).max(3650).optional(), // 0 = forever, max 10 years
  databaseMetricsRetentionDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Mask sensitive fields in settings response
 */
function maskSensitiveFields(settings: {
  doRegistryToken?: string | null;
  [key: string]: unknown;
}): typeof settings & { doRegistryTokenSet: boolean } {
  const masked = { ...settings, doRegistryTokenSet: !!settings.doRegistryToken };
  // Replace actual token with masked version
  if (masked.doRegistryToken) {
    const token = masked.doRegistryToken;
    masked.doRegistryToken = token.length > 8 ? `****${token.slice(-4)}` : '****';
  }
  return masked;
}

export async function systemSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get current system settings (all authenticated users)
  fastify.get(
    '/api/settings/system',
    { preHandler: [fastify.authenticate] },
    async () => {
      const settings = await getSystemSettings();
      return {
        settings: maskSensitiveFields(settings),
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

      // Handle empty string as null for URL and token fields
      const updateData = { ...body.data };
      if (updateData.publicUrl === '') {
        updateData.publicUrl = null;
      }
      if (updateData.agentCallbackUrl === '') {
        updateData.agentCallbackUrl = null;
      }
      if (updateData.doRegistryToken === '') {
        updateData.doRegistryToken = null;
      }

      const settings = await updateSystemSettings(updateData);

      // Don't log the actual token value in audit
      const auditDetails = { ...body.data };
      if (auditDetails.doRegistryToken) {
        auditDetails.doRegistryToken = '(updated)';
      }

      await logAudit({
        action: 'update',
        resourceType: 'system_settings',
        resourceId: 'singleton',
        resourceName: 'System Settings',
        details: { changes: auditDetails },
        userId: request.authUser!.id,
      });

      return { settings: maskSensitiveFields(settings) };
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

      return { settings: maskSensitiveFields(settings), message: 'Settings reset to defaults' };
    }
  );
}
