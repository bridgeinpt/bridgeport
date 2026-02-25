import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    server: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    service: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    registryConnection: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn(),
  LocalClient: vi.fn(),
  DockerSSH: vi.fn(),
  isLocalhost: vi.fn(),
  createClientForServer: vi.fn(),
}));

vi.mock('../lib/docker.js', () => ({
  createDockerClientForServer: vi.fn(),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn(),
}));

vi.mock('../lib/image-utils.js', () => ({
  parseRegistryFromImage: vi.fn().mockReturnValue({
    registryUrl: 'docker.io',
    isDockerHub: true,
  }),
}));

vi.mock('../lib/scheduler.js', () => ({
  checkServiceUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./image-management.js', () => ({
  findOrCreateContainerImage: vi.fn().mockResolvedValue({ id: 'img-1' }),
}));

import {
  createServer,
  updateServer,
  getServer,
  listServers,
  deleteServer,
  determineHealthStatus,
  determineOverallStatus,
} from './servers.js';

describe('servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createServer', () => {
    it('should create a server with required fields', async () => {
      const mockServer = {
        id: 'srv-1',
        name: 'web-server',
        hostname: '10.0.0.1',
        tags: '[]',
        environmentId: 'env-1',
      };
      mockPrisma.server.create.mockResolvedValue(mockServer);

      const result = await createServer('env-1', {
        name: 'web-server',
        hostname: '10.0.0.1',
      });

      expect(result).toEqual(mockServer);
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: {
          name: 'web-server',
          hostname: '10.0.0.1',
          publicIp: undefined,
          tags: '[]',
          environmentId: 'env-1',
        },
      });
    });

    it('should serialize tags as JSON', async () => {
      mockPrisma.server.create.mockResolvedValue({});

      await createServer('env-1', {
        name: 'web-server',
        hostname: '10.0.0.1',
        tags: ['web', 'production'],
      });

      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: JSON.stringify(['web', 'production']),
        }),
      });
    });

    it('should include publicIp when provided', async () => {
      mockPrisma.server.create.mockResolvedValue({});

      await createServer('env-1', {
        name: 'web-server',
        hostname: '10.0.0.1',
        publicIp: '203.0.113.1',
      });

      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          publicIp: '203.0.113.1',
        }),
      });
    });
  });

  describe('updateServer', () => {
    it('should update specified fields only', async () => {
      mockPrisma.server.update.mockResolvedValue({});

      await updateServer('srv-1', { name: 'new-name' });

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: { name: 'new-name' },
      });
    });

    it('should set publicIp to null when explicitly set to empty', async () => {
      mockPrisma.server.update.mockResolvedValue({});

      await updateServer('srv-1', { publicIp: '' });

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: { publicIp: null },
      });
    });

    it('should serialize tags as JSON on update', async () => {
      mockPrisma.server.update.mockResolvedValue({});

      await updateServer('srv-1', { tags: ['updated'] });

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: expect.objectContaining({
          tags: JSON.stringify(['updated']),
        }),
      });
    });

    it('should update dockerMode', async () => {
      mockPrisma.server.update.mockResolvedValue({});

      await updateServer('srv-1', { dockerMode: 'socket' });

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: { dockerMode: 'socket' },
      });
    });
  });

  describe('getServer', () => {
    it('should return server with services included', async () => {
      const mockResult = {
        id: 'srv-1',
        name: 'web-server',
        services: [{ id: 'svc-1', containerImage: {} }],
      };
      mockPrisma.server.findUnique.mockResolvedValue(mockResult);

      const result = await getServer('srv-1');

      expect(result).toEqual(mockResult);
      expect(mockPrisma.server.findUnique).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        include: {
          services: {
            include: { containerImage: true },
          },
        },
      });
    });

    it('should return null for non-existent server', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);

      const result = await getServer('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('listServers', () => {
    it('should return servers with total count', async () => {
      const mockServers = [{ id: 'srv-1' }, { id: 'srv-2' }];
      mockPrisma.server.findMany.mockResolvedValue(mockServers);
      mockPrisma.server.count.mockResolvedValue(2);

      const result = await listServers('env-1');

      expect(result).toEqual({ servers: mockServers, total: 2 });
    });

    it('should use default limit 25 and offset 0', async () => {
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.count.mockResolvedValue(0);

      await listServers('env-1');

      expect(mockPrisma.server.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1' },
        orderBy: { name: 'asc' },
        take: 25,
        skip: 0,
      });
    });

    it('should respect custom limit and offset', async () => {
      mockPrisma.server.findMany.mockResolvedValue([]);
      mockPrisma.server.count.mockResolvedValue(0);

      await listServers('env-1', { limit: 10, offset: 5 });

      expect(mockPrisma.server.findMany).toHaveBeenCalledWith({
        where: { environmentId: 'env-1' },
        orderBy: { name: 'asc' },
        take: 10,
        skip: 5,
      });
    });
  });

  describe('deleteServer', () => {
    it('should delete a server by ID', async () => {
      mockPrisma.server.delete.mockResolvedValue({});

      await deleteServer('srv-1');

      expect(mockPrisma.server.delete).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
      });
    });
  });

  describe('determineHealthStatus', () => {
    it('should return unknown when not running', () => {
      expect(determineHealthStatus('healthy', false)).toBe('unknown');
    });

    it('should return healthy when container health is healthy', () => {
      expect(determineHealthStatus('healthy', true)).toBe('healthy');
    });

    it('should return unhealthy when container health is unhealthy', () => {
      expect(determineHealthStatus('unhealthy', true)).toBe('unhealthy');
    });

    it('should use URL health when no container healthcheck', () => {
      expect(determineHealthStatus(undefined, true, { success: true })).toBe('healthy');
      expect(determineHealthStatus(undefined, true, { success: false, error: 'timeout' })).toBe('unhealthy');
    });

    it('should return none when no healthcheck and no URL check', () => {
      expect(determineHealthStatus(undefined, true)).toBe('none');
    });

    it('should return unknown for unrecognized health value', () => {
      expect(determineHealthStatus('starting', true)).toBe('unknown');
    });
  });

  describe('determineOverallStatus', () => {
    it('should return not_found when container state is not_found', () => {
      expect(determineOverallStatus('not_found', false, 'unknown')).toBe('not_found');
    });

    it('should return stopped when not running', () => {
      expect(determineOverallStatus('exited', false, 'unknown')).toBe('stopped');
    });

    it('should return unhealthy when health is unhealthy', () => {
      expect(determineOverallStatus('running', true, 'unhealthy')).toBe('unhealthy');
    });

    it('should return healthy when health is healthy', () => {
      expect(determineOverallStatus('running', true, 'healthy')).toBe('healthy');
    });

    it('should return running when health is unknown', () => {
      expect(determineOverallStatus('running', true, 'unknown')).toBe('running');
    });

    it('should return running when health is none', () => {
      expect(determineOverallStatus('running', true, 'none')).toBe('running');
    });
  });
});
