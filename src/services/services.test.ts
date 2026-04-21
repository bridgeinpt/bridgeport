import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLocalClient, mockSSHClient, mockDocker } = vi.hoisted(() => ({
  mockPrisma: {
    service: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockLocalClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  },
  mockSSHClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  },
  mockDocker: {
    getContainerHealth: vi.fn(),
    checkUrl: vi.fn(),
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn().mockImplementation(function() { return mockSSHClient; }),
  LocalClient: vi.fn().mockImplementation(function() { return mockLocalClient; }),
  DockerSSH: vi.fn().mockImplementation(function() { return mockDocker; }),
  isLocalhost: vi.fn().mockReturnValue(false),
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({
    username: 'root',
    privateKey: 'fake-key',
  }),
}));

import { checkServiceHealth } from './services.js';
import { isLocalhost } from '../lib/ssh.js';
import { getEnvironmentSshKey } from '../routes/environments.js';

describe('services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocker.getContainerHealth.mockResolvedValue({
      running: true,
      state: 'running',
      status: 'Up 2 hours',
      health: 'healthy',
    });
    mockDocker.checkUrl.mockResolvedValue({ success: true, statusCode: 200 });
  });

  describe('checkServiceHealth', () => {
    const mockService = {
      id: 'svc-1',
      containerName: 'web-app',
      healthCheckUrl: null,
      server: {
        hostname: '10.0.0.1',
        environmentId: 'env-1',
      },
    };

    it('should throw when service not found', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(null);

      await expect(checkServiceHealth('nonexistent')).rejects.toThrow('Service not found');
    });

    it('should check container health via Docker', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('healthy');
      expect(result.container.running).toBe(true);
      expect(result.container.health).toBe('healthy');
      expect(mockDocker.getContainerHealth).toHaveBeenCalledWith('web-app');
    });

    it('should check URL health when healthCheckUrl is configured', async () => {
      const serviceWithUrl = {
        ...mockService,
        healthCheckUrl: 'http://localhost:8080/health',
      };
      mockPrisma.service.findUnique.mockResolvedValue(serviceWithUrl);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.url).not.toBeNull();
      expect(result.url!.success).toBe(true);
      expect(mockDocker.checkUrl).toHaveBeenCalledWith('http://localhost:8080/health');
    });

    it('should not check URL when no healthCheckUrl', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.url).toBeNull();
      expect(mockDocker.checkUrl).not.toHaveBeenCalled();
    });

    it('should report unhealthy when container is unhealthy', async () => {
      mockDocker.getContainerHealth.mockResolvedValue({
        running: true,
        state: 'running',
        status: 'Up 2 hours (unhealthy)',
        health: 'unhealthy',
      });
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('unhealthy');
    });

    it('should report unhealthy when URL check fails', async () => {
      mockDocker.getContainerHealth.mockResolvedValue({
        running: true,
        state: 'running',
        status: 'Up 2 hours',
        health: undefined, // no docker healthcheck
      });
      mockDocker.checkUrl.mockResolvedValue({
        success: false,
        error: 'Connection refused',
      });

      const serviceWithUrl = {
        ...mockService,
        healthCheckUrl: 'http://localhost:8080/health',
      };
      mockPrisma.service.findUnique.mockResolvedValue(serviceWithUrl);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('unhealthy');
    });

    it('should report not_found when container is not found', async () => {
      mockDocker.getContainerHealth.mockResolvedValue({
        running: false,
        state: 'not_found',
        status: '',
      });
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('not_found');
    });

    it('should report stopped when container is not running', async () => {
      mockDocker.getContainerHealth.mockResolvedValue({
        running: false,
        state: 'exited',
        status: 'Exited (0)',
      });
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('stopped');
    });

    it('should use LocalClient for localhost', async () => {
      vi.mocked(isLocalhost).mockReturnValue(true);
      const localService = {
        ...mockService,
        server: { hostname: 'localhost', environmentId: 'env-1' },
      };
      mockPrisma.service.findUnique.mockResolvedValue(localService);
      mockPrisma.service.update.mockResolvedValue({});

      await checkServiceHealth('svc-1');

      // LocalClient should have been used (connected)
      expect(mockLocalClient.connect).toHaveBeenCalled();
    });

    it('should throw when SSH key not configured for remote server', async () => {
      vi.mocked(isLocalhost).mockReturnValue(false);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);
      mockPrisma.service.findUnique.mockResolvedValue(mockService);

      await expect(checkServiceHealth('svc-1')).rejects.toThrow('SSH key not configured');
    });

    it('should update service status in database', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      await checkServiceHealth('svc-1');

      expect(mockPrisma.service.update).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: {
          status: 'healthy',
          lastCheckedAt: expect.any(Date),
        },
      });
    });

    it('should disconnect client in finally block', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      await checkServiceHealth('svc-1');

      expect(mockSSHClient.disconnect).toHaveBeenCalled();
    });

    it('should report running when healthy URL but no container healthcheck', async () => {
      mockDocker.getContainerHealth.mockResolvedValue({
        running: true,
        state: 'running',
        status: 'Up 2 hours',
        health: undefined,
      });

      const serviceWithUrl = {
        ...mockService,
        healthCheckUrl: 'http://localhost:8080/health',
      };
      mockPrisma.service.findUnique.mockResolvedValue(serviceWithUrl);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.status).toBe('healthy');
    });

    it('should return lastCheckedAt as ISO string', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(mockService);
      mockPrisma.service.update.mockResolvedValue({});

      const result = await checkServiceHealth('svc-1');

      expect(result.lastCheckedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });
});
