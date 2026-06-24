import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getSystemSettings,
  updateSystemSettings,
  resetSystemSettings,
  SYSTEM_SETTINGS_DEFAULTS,
} from '../services/system-settings.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { validateBody } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';
import { RETENTION_BOUNDS, PRESETS } from '../services/database-backup.js';

/** True if `tz` is an IANA timezone Intl can resolve (rejects garbage). */
function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
  auditLogRetentionDays: z.number().int().min(0).max(3650).optional(), // 0 = forever, max 10 years
  databaseMetricsRetentionDays: z.number().int().min(1).max(365).optional(),
  notificationRetentionDays: z.number().int().min(1).max(365).optional(),
  healthLogRetentionDays: z.number().int().min(1).max(365).optional(),
  webhookDeliveryRetentionDays: z.number().int().min(1).max(365).optional(),
  imageDigestRetentionDays: z.number().int().min(1).max(3650).optional(),

  // Backup rotation & retention (issue #291). Tier bounds reuse RETENTION_BOUNDS.
  timezone: z.string().min(1).refine(isValidTimezone, 'Invalid IANA timezone').optional(),
  backupRetentionPreset: z.enum(['lean', 'balanced', 'long_term', 'custom']).optional(),
  backupRetentionKeepLast: z.number().int().min(RETENTION_BOUNDS.keepLast.min).max(RETENTION_BOUNDS.keepLast.max).optional(),
  backupRetentionDaily: z.number().int().min(RETENTION_BOUNDS.daily.min).max(RETENTION_BOUNDS.daily.max).optional(),
  backupRetentionWeekly: z.number().int().min(RETENTION_BOUNDS.weekly.min).max(RETENTION_BOUNDS.weekly.max).optional(),
  backupRetentionMonthly: z.number().int().min(RETENTION_BOUNDS.monthly.min).max(RETENTION_BOUNDS.monthly.max).optional(),
  backupRetentionYearly: z.number().int().min(RETENTION_BOUNDS.yearly.min).max(RETENTION_BOUNDS.yearly.max).optional(),
  backupRetentionMinFloor: z.number().int().min(RETENTION_BOUNDS.minFloor.min).max(RETENTION_BOUNDS.minFloor.max).optional(),
  backupRetentionMaxTotalBytes: z.number().int().min(0).nullable().optional(), // persisted as BigInt; null = off
  failedBackupRetentionDays: z.number().int().min(1).max(3650).optional(),
  backupRotationConfirmThreshold: z.number().int().min(0).max(10000).optional(),
});

/**
 * Serialize SystemSettings for JSON: the only non-JSON-safe field is the
 * BigInt `backupRetentionMaxTotalBytes` (null = off), converted to a number.
 */
function serializeSettings(settings: Awaited<ReturnType<typeof getSystemSettings>>) {
  return {
    ...settings,
    backupRetentionMaxTotalBytes:
      settings.backupRetentionMaxTotalBytes == null ? null : Number(settings.backupRetentionMaxTotalBytes),
  };
}

export async function systemSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get current system settings (all authenticated users)
  fastify.get(
    '/api/settings/system',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Get current system settings',
        errors: [401],
      }),
    },
    async () => {
      const settings = await getSystemSettings();
      return {
        settings: serializeSettings(settings),
        defaults: SYSTEM_SETTINGS_DEFAULTS,
      };
    }
  );

  // Update system settings (admin only)
  fastify.put(
    '/api/settings/system',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Update system settings (admin only)',
        body: updateSettingsSchema,
        errors: [400, 401, 403],
      }),
    },
    async (request, reply) => {
      const body = validateBody(updateSettingsSchema, request, reply);
      if (!body) return;

      // Validate webhookRetryDelaysMs is valid JSON array if provided
      if (body.webhookRetryDelaysMs) {
        try {
          const delays = JSON.parse(body.webhookRetryDelaysMs);
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

      // Handle empty string as null for URL fields, and convert the BigInt
      // backup size cap from its number|null input (Prisma column is BigInt?).
      const { backupRetentionMaxTotalBytes, ...rest } = body;
      const updateData: Parameters<typeof updateSystemSettings>[0] = { ...rest };
      if (updateData.publicUrl === '') {
        updateData.publicUrl = null;
      }
      if (updateData.agentCallbackUrl === '') {
        updateData.agentCallbackUrl = null;
      }
      if (backupRetentionMaxTotalBytes !== undefined) {
        updateData.backupRetentionMaxTotalBytes =
          backupRetentionMaxTotalBytes === null ? null : BigInt(backupRetentionMaxTotalBytes);
      }

      // Reconcile the global-default tiers to a non-custom preset server-side
      // (issue #291). When the admin picks lean/balanced/long_term, the six tier
      // fields MUST match PRESETS[preset] — otherwise stale tier values persist
      // and resolveRetentionPolicy's inherited branch applies the wrong
      // retention. Mirrors how the per-DB PUT derives tiers from the preset.
      // Only runs when a known non-custom preset is in the request; 'custom'
      // (and an absent preset) leave the submitted tiers untouched.
      // backupRetentionMaxTotalBytes is left as submitted.
      if (body.backupRetentionPreset && body.backupRetentionPreset !== 'custom') {
        const tiers = PRESETS[body.backupRetentionPreset];
        updateData.backupRetentionKeepLast = tiers.keepLast;
        updateData.backupRetentionDaily = tiers.daily;
        updateData.backupRetentionWeekly = tiers.weekly;
        updateData.backupRetentionMonthly = tiers.monthly;
        updateData.backupRetentionYearly = tiers.yearly;
        updateData.backupRetentionMinFloor = tiers.minFloor;
      }

      const settings = await updateSystemSettings(updateData);

      await logAudit({
        action: 'update',
        resourceType: 'system_settings',
        resourceId: 'singleton',
        resourceName: 'System Settings',
        details: { changes: body },
        ...actorFrom(request),
      });

      return { settings: serializeSettings(settings) };
    }
  );

  // Reset system settings to defaults (admin only)
  fastify.post(
    '/api/settings/system/reset',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Reset system settings to defaults (admin only)',
        errors: [401, 403],
      }),
    },
    async (request) => {
      const settings = await resetSystemSettings();

      await logAudit({
        action: 'update',
        resourceType: 'system_settings',
        resourceId: 'singleton',
        resourceName: 'System Settings',
        details: { action: 'reset_to_defaults' },
        ...actorFrom(request),
      });

      return { settings: serializeSettings(settings), message: 'Settings reset to defaults' };
    }
  );
}
