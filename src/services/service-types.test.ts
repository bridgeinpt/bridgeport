import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    serviceType: {
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

import { initializeServiceTypes } from './service-types.js';

describe('service-types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initializeServiceTypes', () => {
    it('creates default service types when none exist', async () => {
      mockPrisma.serviceType.count.mockResolvedValue(0);
      mockPrisma.serviceType.create.mockResolvedValue({});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await initializeServiceTypes();

      // Should have created 3 default types (django, nodejs, generic)
      expect(mockPrisma.serviceType.create).toHaveBeenCalledTimes(3);

      // Verify Generic type was created
      const genericCall = mockPrisma.serviceType.create.mock.calls.find(
        (c: any) => c[0].data.name === 'generic'
      );
      expect(genericCall).toBeDefined();
      expect(genericCall![0].data.displayName).toBe('Generic');

      consoleSpy.mockRestore();
    });

    it('does not create types when types already exist', async () => {
      mockPrisma.serviceType.count.mockResolvedValue(1);

      await initializeServiceTypes();

      expect(mockPrisma.serviceType.create).not.toHaveBeenCalled();
    });

    it('is idempotent when called on already-initialized DB', async () => {
      // First call: no types exist
      mockPrisma.serviceType.count.mockResolvedValueOnce(0);
      mockPrisma.serviceType.create.mockResolvedValue({});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await initializeServiceTypes();
      const firstCallCount = mockPrisma.serviceType.create.mock.calls.length;

      // Second call: types now exist
      mockPrisma.serviceType.count.mockResolvedValueOnce(3);

      await initializeServiceTypes();

      // No additional creates on second call
      expect(mockPrisma.serviceType.create.mock.calls.length).toBe(firstCallCount);

      consoleSpy.mockRestore();
    });

    it('creates service type commands via nested create', async () => {
      mockPrisma.serviceType.count.mockResolvedValue(0);
      mockPrisma.serviceType.create.mockResolvedValue({});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await initializeServiceTypes();

      // Each create call should include nested commands
      for (const call of mockPrisma.serviceType.create.mock.calls) {
        expect(call[0].data.commands).toBeDefined();
        expect(call[0].data.commands.create).toBeDefined();
        expect(call[0].data.commands.create.length).toBeGreaterThan(0);
      }

      consoleSpy.mockRestore();
    });
  });
});
