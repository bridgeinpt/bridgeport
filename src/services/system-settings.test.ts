import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    systemSettings: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

import {
  getSystemSettings,
  updateSystemSettings,
  resetSystemSettings,
  invalidateSettingsCache,
  parseWebhookRetryDelays,
  SYSTEM_SETTINGS_DEFAULTS,
} from './system-settings.js';

const defaultSettings = {
  id: 'singleton',
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
  updatedAt: new Date(),
};

describe('system-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSettingsCache();
  });

  describe('getSystemSettings', () => {
    it('creates singleton on first call', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);

      const settings = await getSystemSettings();

      expect(settings).toBeDefined();
      expect(settings.id).toBe('singleton');
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        create: { id: 'singleton' },
        update: {},
      });
    });

    it('returns cached settings on subsequent calls', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);

      const first = await getSystemSettings();
      const second = await getSystemSettings();

      // Same reference = cached
      expect(first).toBe(second);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledTimes(1);
    });

    it('returns default values for new settings', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);

      const settings = await getSystemSettings();

      expect(settings.sshCommandTimeoutMs).toBe(SYSTEM_SETTINGS_DEFAULTS.sshCommandTimeoutMs);
      expect(settings.webhookMaxRetries).toBe(SYSTEM_SETTINGS_DEFAULTS.webhookMaxRetries);
      expect(settings.maxUploadSizeMb).toBe(SYSTEM_SETTINGS_DEFAULTS.maxUploadSizeMb);
    });
  });

  describe('updateSystemSettings', () => {
    it('updates specific settings', async () => {
      const updatedSettings = {
        ...defaultSettings,
        sshCommandTimeoutMs: 120000,
        webhookMaxRetries: 5,
      };
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);
      mockPrisma.systemSettings.update.mockResolvedValue(updatedSettings);

      const updated = await updateSystemSettings({
        sshCommandTimeoutMs: 120000,
        webhookMaxRetries: 5,
      });

      expect(updated.sshCommandTimeoutMs).toBe(120000);
      expect(updated.webhookMaxRetries).toBe(5);
    });

    it('refreshes cache after update', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);
      const updatedSettings = { ...defaultSettings, sshCommandTimeoutMs: 99999 };
      mockPrisma.systemSettings.update.mockResolvedValue(updatedSettings);

      await getSystemSettings(); // populate cache
      await updateSystemSettings({ sshCommandTimeoutMs: 99999 });

      const settings = await getSystemSettings();
      expect(settings.sshCommandTimeoutMs).toBe(99999);
    });

    it('preserves other settings when updating one', async () => {
      const updatedSettings = { ...defaultSettings, sshCommandTimeoutMs: 99999 };
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);
      mockPrisma.systemSettings.update.mockResolvedValue(updatedSettings);

      await updateSystemSettings({ sshCommandTimeoutMs: 99999 });
      const settings = await getSystemSettings();

      expect(settings.sshCommandTimeoutMs).toBe(99999);
      expect(settings.webhookMaxRetries).toBe(SYSTEM_SETTINGS_DEFAULTS.webhookMaxRetries);
    });
  });

  describe('resetSystemSettings', () => {
    it('resets all settings to defaults', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);

      const reset = await resetSystemSettings();

      expect(reset.sshCommandTimeoutMs).toBe(SYSTEM_SETTINGS_DEFAULTS.sshCommandTimeoutMs);
      expect(reset.webhookMaxRetries).toBe(SYSTEM_SETTINGS_DEFAULTS.webhookMaxRetries);
      expect(reset.maxUploadSizeMb).toBe(SYSTEM_SETTINGS_DEFAULTS.maxUploadSizeMb);
    });

    it('refreshes cache after reset', async () => {
      // Populate cache with updated
      const updatedSettings = { ...defaultSettings, sshCommandTimeoutMs: 999 };
      mockPrisma.systemSettings.upsert
        .mockResolvedValueOnce(updatedSettings) // initial get
        .mockResolvedValue(defaultSettings); // reset
      mockPrisma.systemSettings.update.mockResolvedValue(updatedSettings);

      await getSystemSettings();
      await resetSystemSettings();

      const settings = await getSystemSettings();
      expect(settings.sshCommandTimeoutMs).toBe(SYSTEM_SETTINGS_DEFAULTS.sshCommandTimeoutMs);
    });

    it('clears publicUrl on reset', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...defaultSettings,
        publicUrl: null,
      });

      const reset = await resetSystemSettings();
      expect(reset.publicUrl).toBeNull();
    });
  });

  describe('invalidateSettingsCache', () => {
    it('forces re-fetch on next getSystemSettings call', async () => {
      mockPrisma.systemSettings.upsert.mockResolvedValue(defaultSettings);

      await getSystemSettings();
      invalidateSettingsCache();
      await getSystemSettings();

      // Should have been called twice (initial + after invalidation)
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('parseWebhookRetryDelays', () => {
    it('parses valid JSON array', () => {
      const settings = { webhookRetryDelaysMs: '[1000,2000,3000]' } as any;
      expect(parseWebhookRetryDelays(settings)).toEqual([1000, 2000, 3000]);
    });

    it('returns defaults for invalid JSON', () => {
      const settings = { webhookRetryDelaysMs: 'not-json' } as any;
      const result = parseWebhookRetryDelays(settings);
      expect(result).toEqual(JSON.parse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs));
    });

    it('returns defaults for non-array JSON', () => {
      const settings = { webhookRetryDelaysMs: '{"a": 1}' } as any;
      const result = parseWebhookRetryDelays(settings);
      expect(result).toEqual(JSON.parse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs));
    });

    it('returns defaults for array with non-numbers', () => {
      const settings = { webhookRetryDelaysMs: '["a","b"]' } as any;
      const result = parseWebhookRetryDelays(settings);
      expect(result).toEqual(JSON.parse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs));
    });

    it('returns defaults for empty string', () => {
      const settings = { webhookRetryDelaysMs: '' } as any;
      const result = parseWebhookRetryDelays(settings);
      expect(result).toEqual(JSON.parse(SYSTEM_SETTINGS_DEFAULTS.webhookRetryDelaysMs));
    });
  });
});
