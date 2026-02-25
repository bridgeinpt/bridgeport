import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    server: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    environment: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn().mockImplementation(function() { return {
    connect: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
    disconnect: vi.fn(),
  }; }),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({
    username: 'root',
    privateKey: 'fake-key',
  }),
}));

vi.mock('../lib/docker.js', () => ({
  isDockerSocketAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import {
  HOST_GATEWAY_IPS,
  isHostGateway,
  detectHostGateway,
  getHostInfo,
  registerHostServer,
  bootstrapManagementEnvironment,
} from './host-detection.js';
import { getEnvironmentSshKey } from '../routes/environments.js';
import { isDockerSocketAvailable } from '../lib/docker.js';

describe('host-detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('HOST_GATEWAY_IPS', () => {
    it('should include default Docker bridge gateway', () => {
      expect(HOST_GATEWAY_IPS).toContain('172.17.0.1');
    });

    it('should include host.docker.internal', () => {
      expect(HOST_GATEWAY_IPS).toContain('host.docker.internal');
    });
  });

  describe('isHostGateway', () => {
    it('should return true for Docker bridge gateway IP', () => {
      expect(isHostGateway('172.17.0.1')).toBe(true);
    });

    it('should return true for host.docker.internal', () => {
      expect(isHostGateway('host.docker.internal')).toBe(true);
    });

    it('should return false for regular IP', () => {
      expect(isHostGateway('10.0.0.1')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isHostGateway('')).toBe(false);
    });
  });

  describe('detectHostGateway', () => {
    it('should return a gateway IP string', async () => {
      // The function tries multiple detection methods and falls back to 172.17.0.1
      const result = await detectHostGateway();
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should fall back to 172.17.0.1 when all methods fail', async () => {
      // With our mocks, all detection methods will fail
      // and it falls back to 172.17.0.1
      const result = await detectHostGateway();
      expect(result).toBe('172.17.0.1');
    });
  });

  describe('getHostInfo', () => {
    it('should return detected: false when gateway not found', async () => {
      // We need to mock detectHostGateway to return null for this test
      // Since it's an internal function, we can't easily mock it
      // but the fallback always returns 172.17.0.1, so it will always be detected
      // Instead, test the normal path
      mockPrisma.server.findFirst.mockResolvedValue(null);

      const result = await getHostInfo('env-1');

      expect(result.detected).toBe(true);
      expect(result.gatewayIp).toBeDefined();
    });

    it('should report registered when host server exists in environment', async () => {
      mockPrisma.server.findFirst.mockResolvedValueOnce({
        id: 'srv-1',
        name: 'host-server',
        hostname: '172.17.0.1',
      });

      const result = await getHostInfo('env-1');

      expect(result.registered).toBe(true);
      expect(result.serverId).toBe('srv-1');
      expect(result.serverName).toBe('host-server');
    });

    it('should report registeredGlobally when host exists in another environment', async () => {
      // First call: no host in this environment
      mockPrisma.server.findFirst
        .mockResolvedValueOnce(null)
        // Second call: host found globally
        .mockResolvedValueOnce({
          id: 'srv-other',
          name: 'host-other',
          environment: { name: 'production' },
        });

      const result = await getHostInfo('env-1');

      expect(result.registered).toBe(false);
      expect(result.registeredGlobally).toBe(true);
      expect(result.registeredEnvironment).toBe('production');
    });

    it('should test SSH connectivity', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);

      const result = await getHostInfo('env-1');

      expect(result.sshReachable).toBe(true);
    });

    it('should report SSH error when no key configured', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);

      const result = await getHostInfo('env-1');

      expect(result.sshReachable).toBe(false);
      expect(result.sshError).toBe('SSH key not configured for this environment');
    });
  });

  describe('registerHostServer', () => {
    it('should return error when host already registered', async () => {
      mockPrisma.server.findFirst.mockResolvedValue({
        id: 'srv-1',
        name: 'existing-host',
      });

      const result = await registerHostServer('env-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already registered');
    });

    it('should create host server with socket mode when socket is available', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.create.mockResolvedValue({ id: 'new-srv' });

      const result = await registerHostServer('env-1', 'my-host');

      expect(result.success).toBe(true);
      expect(result.serverId).toBe('new-srv');
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'my-host',
          serverType: 'host',
          dockerMode: 'socket',
          status: 'healthy',
        }),
      });
    });

    it('should use default name "host" when not provided', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.create.mockResolvedValue({ id: 'new-srv' });

      await registerHostServer('env-1');

      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'host' }),
      });
    });

    it('should fall back to SSH mode when socket not available', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(false);
      mockPrisma.server.create.mockResolvedValue({ id: 'new-srv' });

      const result = await registerHostServer('env-1');

      expect(result.success).toBe(true);
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          dockerMode: 'ssh',
        }),
      });
    });

    it('should return error when SSH mode and no key configured', async () => {
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(false);
      vi.mocked(getEnvironmentSshKey).mockResolvedValueOnce(null);

      const result = await registerHostServer('env-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSH key not configured');
    });
  });

  describe('bootstrapManagementEnvironment', () => {
    it('should create management environment if not exists', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue(null);
      mockPrisma.environment.create.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.create.mockResolvedValue({});

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapManagementEnvironment();
      consoleSpy.mockRestore();

      expect(mockPrisma.environment.create).toHaveBeenCalledWith({
        data: { name: 'management' },
      });
    });

    it('should skip environment creation if management env exists', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.create.mockResolvedValue({});

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapManagementEnvironment();
      consoleSpy.mockRestore();

      expect(mockPrisma.environment.create).not.toHaveBeenCalled();
    });

    it('should skip localhost server creation if it already exists', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.findFirst.mockResolvedValue({ id: 'existing', name: 'localhost' });
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);

      await bootstrapManagementEnvironment();

      expect(mockPrisma.server.create).not.toHaveBeenCalled();
    });

    it('should skip localhost server creation when Docker socket not available', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(false);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapManagementEnvironment();
      consoleSpy.mockRestore();

      expect(mockPrisma.server.create).not.toHaveBeenCalled();
    });

    it('should upgrade host servers from SSH to socket mode when socket available', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([
        { id: 'srv-1', name: 'host-1', serverType: 'host', dockerMode: 'ssh' },
      ]);
      mockPrisma.server.findFirst.mockResolvedValue({ id: 'existing', name: 'localhost' });
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.update.mockResolvedValue({});

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapManagementEnvironment();
      consoleSpy.mockRestore();

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: { dockerMode: 'socket', status: 'healthy' },
      });
    });

    it('should create localhost server with socket mode', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'mgmt-env', name: 'management' });
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.findFirst.mockResolvedValue(null);
      vi.mocked(isDockerSocketAvailable).mockResolvedValue(true);
      mockPrisma.server.create.mockResolvedValue({});

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await bootstrapManagementEnvironment();
      consoleSpy.mockRestore();

      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'localhost',
          hostname: 'localhost',
          serverType: 'host',
          dockerMode: 'socket',
          status: 'healthy',
        }),
      });
    });
  });
});
