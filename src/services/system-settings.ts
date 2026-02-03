import { prisma } from '../lib/db.js';
import type { SystemSettings } from '@prisma/client';

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
  try {
    const delays = JSON.parse(settings.webhookRetryDelaysMs);
    if (Array.isArray(delays) && delays.every(d => typeof d === 'number')) {
      return delays;
    }
  } catch {
    // ignore parse errors
  }
  return JSON.parse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs);
}
