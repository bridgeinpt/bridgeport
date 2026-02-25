import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGeneralSettings,
  mockMonitoringSettings,
  mockOperationsSettings,
  mockDataSettings,
  mockConfigurationSettings,
  mockTx,
} = vi.hoisted(() => ({
  mockGeneralSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  mockMonitoringSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  mockOperationsSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  mockDataSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  mockConfigurationSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  mockTx: {
    generalSettings: { upsert: vi.fn().mockResolvedValue({}) },
    monitoringSettings: { upsert: vi.fn().mockResolvedValue({}) },
    operationsSettings: { upsert: vi.fn().mockResolvedValue({}) },
    dataSettings: { upsert: vi.fn().mockResolvedValue({}) },
    configurationSettings: { upsert: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: {
    generalSettings: mockGeneralSettings,
    monitoringSettings: mockMonitoringSettings,
    operationsSettings: mockOperationsSettings,
    dataSettings: mockDataSettings,
    configurationSettings: mockConfigurationSettings,
    $transaction: vi.fn().mockImplementation((fn: any) => fn(mockTx)),
  },
}));

import {
  getModuleSettings,
  updateModuleSettings,
  resetModuleSettings,
  createDefaultSettings,
  SETTINGS_REGISTRY,
} from './environment-settings.js';

describe('environment-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SETTINGS_REGISTRY', () => {
    it('contains all five modules', () => {
      expect(Object.keys(SETTINGS_REGISTRY)).toEqual([
        'general',
        'monitoring',
        'operations',
        'data',
        'configuration',
      ]);
    });

    it('each setting has required fields', () => {
      for (const [module, defs] of Object.entries(SETTINGS_REGISTRY)) {
        for (const def of defs) {
          expect(def.key, `${module}.${def.key}`).toBeDefined();
          expect(def.type, `${module}.${def.key}.type`).toBeDefined();
          expect(def.default, `${module}.${def.key}.default`).toBeDefined();
          expect(def.label, `${module}.${def.key}.label`).toBeDefined();
          expect(def.widget, `${module}.${def.key}.widget`).toBeDefined();
        }
      }
    });
  });

  describe('getModuleSettings', () => {
    it('returns defaults when no settings exist', async () => {
      mockGeneralSettings.findUnique.mockResolvedValue(null);

      const settings = await getModuleSettings('env-1', 'general');
      expect(settings.sshUser).toBe('root');
    });

    it('returns stored values when settings exist', async () => {
      mockGeneralSettings.findUnique.mockResolvedValue({
        id: 'gs-1',
        environmentId: 'env-1',
        sshUser: 'deploy',
      });

      const settings = await getModuleSettings('env-1', 'general');
      expect(settings.sshUser).toBe('deploy');
    });

    it('returns monitoring defaults', async () => {
      mockMonitoringSettings.findUnique.mockResolvedValue(null);

      const settings = await getModuleSettings('env-1', 'monitoring');
      expect(settings.serverHealthIntervalMs).toBe(60000);
      expect(settings.collectCpu).toBe(true);
    });
  });

  describe('updateModuleSettings', () => {
    it('updates settings and returns changes', async () => {
      // First call for getting current values, second for getting updated values
      mockGeneralSettings.findUnique
        .mockResolvedValueOnce(null) // current: defaults
        .mockResolvedValueOnce({ id: 'gs-1', environmentId: 'env-1', sshUser: 'deploy' });
      mockGeneralSettings.upsert.mockResolvedValue({});

      const { updated, changes } = await updateModuleSettings('env-1', 'general', {
        sshUser: 'deploy',
      });

      expect(updated.sshUser).toBe('deploy');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ key: 'sshUser', from: 'root', to: 'deploy' });
    });

    it('validates integer range constraints', async () => {
      await expect(
        updateModuleSettings('env-1', 'monitoring', {
          serverHealthIntervalMs: 100,
        })
      ).rejects.toThrow('serverHealthIntervalMs must be at least 10000');
    });

    it('validates integer type', async () => {
      await expect(
        updateModuleSettings('env-1', 'monitoring', {
          serverHealthIntervalMs: 'not-a-number',
        })
      ).rejects.toThrow('serverHealthIntervalMs must be an integer');
    });

    it('validates boolean type', async () => {
      await expect(
        updateModuleSettings('env-1', 'monitoring', {
          collectCpu: 'yes',
        })
      ).rejects.toThrow('collectCpu must be a boolean');
    });

    it('validates select options', async () => {
      await expect(
        updateModuleSettings('env-1', 'operations', {
          defaultDockerMode: 'invalid',
        })
      ).rejects.toThrow('defaultDockerMode must be one of: ssh, socket');
    });

    it('rejects unknown setting keys', async () => {
      await expect(
        updateModuleSettings('env-1', 'general', {
          unknownKey: 'value',
        })
      ).rejects.toThrow('Unknown setting: unknownKey');
    });

    it('reports no changes when values are the same', async () => {
      mockGeneralSettings.findUnique
        .mockResolvedValueOnce(null) // current: defaults (sshUser = 'root')
        .mockResolvedValueOnce(null); // after "update": still defaults

      const { changes } = await updateModuleSettings('env-1', 'general', {
        sshUser: 'root',
      });

      expect(changes).toHaveLength(0);
    });

    it('creates settings row on first update (upsert)', async () => {
      mockMonitoringSettings.findUnique
        .mockResolvedValueOnce(null) // current: no row
        .mockResolvedValueOnce({ id: 'ms-1', environmentId: 'env-1', serverHealthIntervalMs: 30000 });
      mockMonitoringSettings.upsert.mockResolvedValue({});

      await updateModuleSettings('env-1', 'monitoring', {
        serverHealthIntervalMs: 30000,
      });

      expect(mockMonitoringSettings.upsert).toHaveBeenCalled();
    });
  });

  describe('resetModuleSettings', () => {
    it('resets to default values', async () => {
      mockGeneralSettings.upsert.mockResolvedValue({});
      mockGeneralSettings.findUnique.mockResolvedValue(null);

      const defaults = await resetModuleSettings('env-1', 'general');
      expect(defaults.sshUser).toBe('root');
    });
  });

  describe('createDefaultSettings', () => {
    it('creates all five setting rows for an environment', async () => {
      await createDefaultSettings('env-1');

      expect(mockTx.generalSettings.upsert).toHaveBeenCalled();
      expect(mockTx.monitoringSettings.upsert).toHaveBeenCalled();
      expect(mockTx.operationsSettings.upsert).toHaveBeenCalled();
      expect(mockTx.dataSettings.upsert).toHaveBeenCalled();
      expect(mockTx.configurationSettings.upsert).toHaveBeenCalled();
    });
  });
});
