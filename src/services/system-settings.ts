import { prisma } from '../lib/db.js';
import type { SystemSettings } from '@prisma/client';
import { safeJsonParse } from '../lib/helpers.js';

// Cache for system settings (refreshed on update)
let cachedSettings: SystemSettings | null = null;

/**
 * Default values for system settings
 */
export const SYSTEM_SETTINGS_DEFAULTS = {
  sshCommandTimeoutMs: 60000,
  sshReadyTimeoutMs: 10000,
  webhookMaxRetries: 3,
  webhookTimeoutMs: 30000,
  webhookRetryDelaysMs: '[1000,5000,15000]',
  pgDumpTimeoutMs: 300000,
  maxUploadSizeMb: 50,
  activeUserWindowMin: 15,
  registryMaxTags: 50,
  defaultLogLines: 50,
  agentStaleThresholdMs: 180000,
  agentOfflineThresholdMs: 300000,
  doRegistryToken: null as string | null,
  auditLogRetentionDays: 90,
  databaseMetricsRetentionDays: 30,
};

/**
 * Get system settings (cached, auto-creates if not exists)
 */
export async function getSystemSettings(): Promise<SystemSettings> {
  if (!cachedSettings) {
    cachedSettings = await prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  }
  return cachedSettings;
}

/**
 * Update system settings and refresh cache
 */
export async function updateSystemSettings(
  data: Partial<Omit<SystemSettings, 'id' | 'updatedAt'>>
): Promise<SystemSettings> {
  // Ensure the singleton exists first
  await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });

  cachedSettings = await prisma.systemSettings.update({
    where: { id: 'singleton' },
    data,
  });
  return cachedSettings;
}

/**
 * Reset system settings to defaults
 */
export async function resetSystemSettings(): Promise<SystemSettings> {
  cachedSettings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {
      sshCommandTimeoutMs: SYSTEM_SETTINGS_DEFAULTS.sshCommandTimeoutMs,
      sshReadyTimeoutMs: SYSTEM_SETTINGS_DEFAULTS.sshReadyTimeoutMs,
      webhookMaxRetries: SYSTEM_SETTINGS_DEFAULTS.webhookMaxRetries,
      webhookTimeoutMs: SYSTEM_SETTINGS_DEFAULTS.webhookTimeoutMs,
      webhookRetryDelaysMs: SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs,
      pgDumpTimeoutMs: SYSTEM_SETTINGS_DEFAULTS.pgDumpTimeoutMs,
      maxUploadSizeMb: SYSTEM_SETTINGS_DEFAULTS.maxUploadSizeMb,
      activeUserWindowMin: SYSTEM_SETTINGS_DEFAULTS.activeUserWindowMin,
      registryMaxTags: SYSTEM_SETTINGS_DEFAULTS.registryMaxTags,
      defaultLogLines: SYSTEM_SETTINGS_DEFAULTS.defaultLogLines,
      publicUrl: null,
      agentCallbackUrl: null,
      agentStaleThresholdMs: SYSTEM_SETTINGS_DEFAULTS.agentStaleThresholdMs,
      agentOfflineThresholdMs: SYSTEM_SETTINGS_DEFAULTS.agentOfflineThresholdMs,
      doRegistryToken: null,
      auditLogRetentionDays: SYSTEM_SETTINGS_DEFAULTS.auditLogRetentionDays,
      databaseMetricsRetentionDays: SYSTEM_SETTINGS_DEFAULTS.databaseMetricsRetentionDays,
    },
  });
  return cachedSettings;
}

/**
 * Invalidate the settings cache (call when settings may have changed externally)
 */
export function invalidateSettingsCache(): void {
  cachedSettings = null;
}

/**
 * Parse webhook retry delays from JSON string
 */
export function parseWebhookRetryDelays(settings: SystemSettings): number[] {
  const delays = safeJsonParse(settings.webhookRetryDelaysMs, [1000, 5000, 15000]);
  if (Array.isArray(delays) && delays.every(d => typeof d === 'number')) {
    return delays;
  }
  return safeJsonParse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs, [1000, 5000, 15000]);
}
