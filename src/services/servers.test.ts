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
    serviceDeployment: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    registryConnection: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    environment: {
      findFirst: vi.fn(),
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

import { createDockerClientForServer } from '../lib/docker.js';
import {
  createServer,
  updateServer,
  getServer,
  listServers,
  deleteServer,
  determineHealthStatus,
  determineOverallStatus,
  discoverContainers,
  listServersForTemplate,
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
    it('should return the server row without including services by default', async () => {
      const mockResult = {
        id: 'srv-1',
        name: 'web-server',
      };
      mockPrisma.server.findUnique.mockResolvedValue(mockResult);

      const result = await getServer('srv-1');

      expect(result).toEqual(mockResult);
      // Default getServer should NOT include serviceDeployments (the relation is
      // loaded on demand via `?include=services` on the route).
      expect(mockPrisma.server.findUnique).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
      });
    });

    it('should include serviceDeployments with nested service+containerImage when includeServices is true', async () => {
      // 2.0: getServer pulls serviceDeployments (per-server runtime) with nested service.
      const mockResult = {
        id: 'srv-1',
        name: 'web-server',
        serviceDeployments: [
          {
            id: 'dep-1',
            containerName: 'web-app',
            service: { id: 'svc-1', name: 'web-app', containerImage: {} },
          },
        ],
      };
      mockPrisma.server.findUnique.mockResolvedValue(mockResult);

      const result = await getServer('srv-1', { includeServices: true });

      expect(result).toEqual(mockResult);
      expect(mockPrisma.server.findUnique).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        include: {
          serviceDeployments: {
            include: {
              service: { include: { containerImage: true } },
            },
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

  describe('discoverContainers', () => {
    const baseServer = {
      id: 'srv-1',
      environmentId: 'env-1',
      hostname: 'host-1',
      dockerMode: 'ssh',
      serverType: 'linux',
    };

    function mockDockerClient(containers: Array<{ name: string; image: string; state: string }>) {
      const containerInfo = {
        state: 'running',
        running: true,
        health: 'healthy',
        image: 'nginx:latest',
        ports: [],
      };
      const dockerClient = {
        listContainers: vi.fn().mockResolvedValue(containers),
        getContainerInfo: vi.fn().mockResolvedValue(containerInfo),
      };
      vi.mocked(createDockerClientForServer).mockResolvedValue({
        dockerClient: dockerClient as never,
        sshClient: null,
        needsConnect: false,
        mode: 'ssh',
      } as never);
      return dockerClient;
    }

    it('matches an existing ServiceDeployment by containerName even when display name has been renamed', async () => {
      // 2.0: discovery matches against ServiceDeployment.containerName, not Service.containerName.
      const existingDeployment = {
        id: 'dep-1',
        containerName: 'keycloak', // the real docker container name
        serverId: 'srv-1',
        service: { name: 'keycloak-1-production', environmentId: 'env-1' },
      };

      mockPrisma.server.findUniqueOrThrow.mockResolvedValue({
        ...baseServer,
        serviceDeployments: [existingDeployment],
      });
      mockPrisma.registryConnection.findMany.mockResolvedValue([]);
      mockDockerClient([{ name: 'keycloak', image: 'nginx:latest', state: 'running' }]);

      mockPrisma.serviceDeployment.findUnique.mockResolvedValue(existingDeployment);
      mockPrisma.serviceDeployment.update.mockResolvedValue({ ...existingDeployment, discoveryStatus: 'found' });

      const result = await discoverContainers('srv-1');

      expect(mockPrisma.serviceDeployment.findUnique).toHaveBeenCalledWith({
        where: {
          serverId_containerName: { serverId: 'srv-1', containerName: 'keycloak' },
        },
      });
      expect(mockPrisma.serviceDeployment.create).not.toHaveBeenCalled();
      expect(mockPrisma.serviceDeployment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'dep-1' } })
      );
      expect(result.missing).toEqual([]);
    });

    it('marks a ServiceDeployment as missing when its containerName is absent from the docker container list', async () => {
      const orphan = {
        id: 'dep-2',
        containerName: 'gone-container',
        serverId: 'srv-1',
        service: { name: 'old-display-name', environmentId: 'env-1' },
      };

      mockPrisma.server.findUniqueOrThrow.mockResolvedValue({
        ...baseServer,
        serviceDeployments: [orphan],
      });
      mockPrisma.registryConnection.findMany.mockResolvedValue([]);
      mockDockerClient([]); // docker reports no containers

      const result = await discoverContainers('srv-1');

      expect(mockPrisma.serviceDeployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep-2' },
          data: expect.objectContaining({ discoveryStatus: 'missing' }),
        })
      );
      // Missing reports the service's display name (from the nested template).
      expect(result.missing).toEqual(['old-display-name']);
    });
  });

  describe('listServersForTemplate', () => {
    function row(name: string, env: string, tags: string[] = []): Record<string, unknown> {
      return {
        id: `id-${name}`,
        name,
        hostname: `host-${name}`,
        publicIp: null,
        tags: JSON.stringify(tags),
        environmentId: env,
      };
    }

    it('defaults to current environment when no environment filter is given', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        row('web-a', 'env-1', ['web']),
        row('web-b', 'env-1', ['web']),
      ]);

      const result = await listServersForTemplate('env-1', {});

      expect(mockPrisma.environment.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.server.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { environmentId: 'env-1' } })
      );
      expect(result.map((s) => s.name)).toEqual(['web-a', 'web-b']);
    });

    it('resolves environment filter by name', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'env-staging-id' });
      mockPrisma.server.findMany.mockResolvedValue([row('s1', 'env-staging-id')]);

      await listServersForTemplate('env-1', { environment: 'staging' });

      expect(mockPrisma.environment.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ id: 'staging' }, { name: 'staging' }] },
        select: { id: true },
      });
      expect(mockPrisma.server.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { environmentId: 'env-staging-id' } })
      );
    });

    it('resolves environment filter by id', async () => {
      // The impl checks both name and id, so passing an id works equivalently.
      mockPrisma.environment.findFirst.mockResolvedValue({ id: 'env-2' });
      mockPrisma.server.findMany.mockResolvedValue([row('s2', 'env-2')]);

      const result = await listServersForTemplate('env-1', { environment: 'env-2' });

      expect(mockPrisma.environment.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ id: 'env-2' }, { name: 'env-2' }] },
        select: { id: true },
      });
      expect(result.map((s) => s.name)).toEqual(['s2']);
    });

    it('returns servers sorted alphabetically by name with parsed tags', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        row('zeta', 'env-1', ['z']),
        row('alpha', 'env-1', ['a', 'b']),
        row('mu', 'env-1', []),
      ]);

      const result = await listServersForTemplate('env-1', {});

      expect(result.map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta']);
      expect(result.find((s) => s.name === 'alpha')?.tags).toEqual(['a', 'b']);
      expect(result.find((s) => s.name === 'mu')?.tags).toEqual([]);
    });

    it('returns empty array (no throw) when environment filter does not match any env', async () => {
      mockPrisma.environment.findFirst.mockResolvedValue(null);

      const result = await listServersForTemplate('env-1', { environment: 'ghost' });

      expect(result).toEqual([]);
      // Critically, we should NOT have queried servers at all if the env was unresolved.
      expect(mockPrisma.server.findMany).not.toHaveBeenCalled();
    });

    it('applies tag and name filters after loading the env', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        row('api-1', 'env-1', ['web']),
        row('api-2', 'env-1', ['db']),
        row('db-1', 'env-1', ['db']),
      ]);

      const result = await listServersForTemplate('env-1', { tag: 'db', name: 'api-*' });

      // tag="db" AND name="api-*" → only api-2 qualifies.
      expect(result.map((s) => s.name)).toEqual(['api-2']);
    });

    it('handles malformed tags JSON without throwing', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        { ...row('a', 'env-1'), tags: 'not-json' },
      ]);

      const result = await listServersForTemplate('env-1', {});

      expect(result).toHaveLength(1);
      expect(result[0].tags).toEqual([]);
    });
  });
});
