import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  prisma: {
    serviceType: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    serviceTypeCommand: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    databaseType: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    databaseTypeCommand: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    database: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../lib/config.js', () => ({
  config: {
    PLUGINS_DIR: './plugins',
  },
}));

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { prisma } from '../lib/db.js';
import { syncPlugins, resetTypeToDefaults, exportTypeAsJson } from './plugin-loader.js';

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockPrisma = vi.mocked(prisma);

describe('plugin-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncPlugins', () => {
    it('handles empty plugin directories gracefully', async () => {
      // readdir throws for non-existent directories
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const result = await syncPlugins();

      expect(result).toBeDefined();
      expect(result.serviceTypes.created).toHaveLength(0);
      expect(result.databaseTypes.created).toHaveLength(0);
    });

    it('loads service type plugins from directory', async () => {
      // Service types directory has one file
      mockReaddir
        .mockResolvedValueOnce(['django.json'] as any) // service-types dir
        .mockResolvedValueOnce([] as any); // database-types dir

      const pluginJson = JSON.stringify({
        name: 'django',
        displayName: 'Django',
        commands: [
          { name: 'shell', displayName: 'Django Shell', command: 'python manage.py shell' },
        ],
      });

      mockReadFile.mockResolvedValue(pluginJson as any);
      mockPrisma.serviceType.findUnique.mockResolvedValue(null as any);
      mockPrisma.serviceType.create.mockResolvedValue({ id: 'st-1', name: 'django' } as any);

      const result = await syncPlugins();

      expect(result.serviceTypes.created).toContain('django');
    });

    it('preserves customized types (smart merge)', async () => {
      mockReaddir
        .mockResolvedValueOnce(['custom.json'] as any)
        .mockResolvedValueOnce([] as any);

      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'custom',
        displayName: 'Custom',
        commands: [
          { name: 'shell', displayName: 'Shell', command: 'bash' },
          { name: 'new-cmd', displayName: 'New', command: 'new' },
        ],
      }) as any);

      // Existing customized type
      mockPrisma.serviceType.findUnique.mockResolvedValue({
        id: 'st-1',
        name: 'custom',
        isCustomized: true,
        source: 'plugin',
        commands: [
          { id: 'cmd-1', name: 'shell', command: 'custom-bash' },
        ],
      } as any);
      mockPrisma.serviceTypeCommand.createMany.mockResolvedValue({ count: 1 } as any);

      const result = await syncPlugins();

      // Should report as skippedCustomized
      expect(result.serviceTypes.skippedCustomized).toContain('custom');
    });
  });

  describe('exportTypeAsJson', () => {
    it('exports service type as JSON file', async () => {
      mockPrisma.serviceType.findUnique.mockResolvedValue({
        id: 'st-1',
        name: 'django',
        displayName: 'Django',
        commands: [
          { name: 'shell', displayName: 'Django Shell', command: 'python manage.py shell', description: null, sortOrder: 0 },
        ],
      } as any);

      mockMkdir.mockResolvedValue(undefined as any);
      mockWriteFile.mockResolvedValue(undefined);

      const result = await exportTypeAsJson('service-type', 'st-1');

      expect(result.written).toBe(true);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('returns error for non-existent type', async () => {
      mockPrisma.serviceType.findUnique.mockResolvedValue(null);

      const result = await exportTypeAsJson('service-type', 'nonexistent');

      expect(result.written).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('resetTypeToDefaults', () => {
    it('resets type to plugin defaults', async () => {
      mockPrisma.serviceType.findUnique.mockResolvedValue({
        id: 'st-1',
        name: 'django',
        source: 'plugin',
      } as any);

      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'django',
        displayName: 'Django',
        commands: [
          { name: 'shell', displayName: 'Shell', command: 'python manage.py shell' },
        ],
      }) as any);

      // Mock $transaction
      mockPrisma.$transaction.mockResolvedValue([{}, {}] as any);

      const result = await resetTypeToDefaults('service-type', 'st-1');

      expect(result).toBe(true);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('returns false for non-existent type', async () => {
      mockPrisma.serviceType.findUnique.mockResolvedValue(null);

      const result = await resetTypeToDefaults('service-type', 'nonexistent');

      expect(result).toBe(false);
    });
  });
});
