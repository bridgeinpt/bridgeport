import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    deployment: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    containerImage: { findUnique: vi.fn() },
  },
}));

vi.mock('../lib/docker.js', () => ({
  createDockerClientForServer: vi.fn(),
  DockerSSH: vi.fn(),
}));

vi.mock('../lib/ssh.js', () => ({
  createSSHClient: vi.fn(),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue('mock-key'),
}));

vi.mock('./compose.js', () => ({
  generateDeploymentArtifacts: vi.fn().mockResolvedValue({ composeFile: 'version: "3"', envFile: '', configFiles: [] }),
  saveDeploymentArtifacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./image-management.js', () => ({
  recordTagDeployment: vi.fn().mockResolvedValue({ id: 'hist-1', tag: 'v2.0', status: 'success' }),
}));

vi.mock('./health-verification.js', () => ({
  verifyServiceHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock('./audit.js', () => ({
  logAudit: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
  sendSystemNotification: vi.fn(),
  NOTIFICATION_TYPES: {
    SYSTEM_DEPLOYMENT_SUCCESS: 'system_deployment_success',
    SYSTEM_DEPLOYMENT_FAILED: 'system_deployment_failed',
  },
}));

vi.mock('../lib/event-bus.js', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

vi.mock('./system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({ defaultLogLines: 50 }),
}));

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { deployService, getDeploymentHistory, getContainerLogs } from './deploy.js';
import { getSystemSettings } from './system-settings.js';

const mockPrisma = vi.mocked(prisma);
const mockCreateDocker = vi.mocked(createDockerClientForServer);
const mockGetSystemSettings = vi.mocked(getSystemSettings);

function createMockServiceData() {
  return {
    id: 'svc-1',
    name: 'web-app',
    containerName: 'web-app',
    imageName: 'registry.com/web-app',
    imageTag: 'v1.0',
    containerImageId: 'img-1',
    serverId: 'srv-1',
    environmentId: 'env-1',
    server: {
      id: 'srv-1',
      hostname: 'test.local',
      dockerMode: 'socket',
      environmentId: 'env-1',
    },
    environment: {
      id: 'env-1',
      name: 'Test',
      sshKey: null,
    },
    containerImage: {
      id: 'img-1',
      imageName: 'registry.com/web-app',
      tagFilter: 'v1.0',
    },
  };
}

describe('deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deployService', () => {
    it('creates deployment record and executes deploy', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({
        id: 'dep-1',
        status: 'running',
        startedAt: new Date(),
      } as any);
      mockPrisma.deployment.update.mockResolvedValue({
        id: 'dep-1',
        status: 'success',
      } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockResolvedValue(undefined),
        restartContainer: vi.fn().mockResolvedValue(undefined),
      };
      mockCreateDocker.mockResolvedValue(mockDocker as any);

      const result = await deployService('svc-1', 'user-1', 'user-id-1', {
        imageTag: 'v2.0',
        pullImage: true,
      });

      expect(mockPrisma.deployment.create).toHaveBeenCalled();
      expect(result.deployment).toBeDefined();
    });

    it('marks deployment as failed on Docker error', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({
        id: 'dep-1',
        status: 'running',
      } as any);
      mockPrisma.deployment.update.mockResolvedValue({
        id: 'dep-1',
        status: 'failed',
      } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockRejectedValue(new Error('Pull failed')),
      };
      mockCreateDocker.mockResolvedValue(mockDocker as any);

      const result = await deployService('svc-1', 'user-1', 'user-id-1', {
        imageTag: 'v2.0',
        pullImage: true,
      });

      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        })
      );
    });
  });

  describe('getDeploymentHistory', () => {
    it('returns deployment history for a service', async () => {
      mockPrisma.deployment.findMany.mockResolvedValue([
        { id: 'dep-1', status: 'success', startedAt: new Date() },
        { id: 'dep-2', status: 'failed', startedAt: new Date() },
      ] as any);

      const history = await getDeploymentHistory('svc-1');

      expect(history).toHaveLength(2);
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { serviceId: 'svc-1' },
        })
      );
    });
  });

  describe('captureContainerLogs (via deployService)', () => {
    // captureContainerLogs is an inner helper; we exercise it by inspecting the
    // log content that ends up persisted via prisma.deployment.update.

    function getPersistedLogs(): string {
      const calls = mockPrisma.deployment.update.mock.calls;
      // The final update carries the full `logs` blob.
      for (let i = calls.length - 1; i >= 0; i--) {
        const data = (calls[i][0] as { data?: { logs?: string } })?.data;
        if (data && typeof data.logs === 'string') return data.logs;
      }
      return '';
    }

    it('appends container logs section on a successful deploy', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'success' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockResolvedValue(undefined),
        restartContainer: vi.fn().mockResolvedValue(undefined),
        listContainers: vi.fn().mockResolvedValue([
          { id: 'c1', name: service.containerName, image: 'web-app:v2.0', status: 'Up', state: 'running' },
        ]),
        getContainerLogs: vi.fn().mockResolvedValue('line one\nline two\n'),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', {
        imageTag: 'v2.0',
        pullImage: true,
        generateArtifacts: false,
      });

      // Container logs were fetched with the default tail and timestamps on.
      expect(mockDocker.getContainerLogs).toHaveBeenCalledWith(
        service.containerName,
        expect.objectContaining({ tail: 50, timestamps: true })
      );

      const logs = getPersistedLogs();
      expect(logs).toContain(`--- container logs (${service.containerName}, last 50 lines) ---`);
      expect(logs).toContain('line one');
      expect(logs).toContain('line two');
    });

    it('emits (no output) when container logs are empty/whitespace', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'success' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockResolvedValue(undefined),
        restartContainer: vi.fn().mockResolvedValue(undefined),
        listContainers: vi.fn().mockResolvedValue([
          { id: 'c1', name: service.containerName, image: 'web-app:v2.0', status: 'Up', state: 'running' },
        ]),
        getContainerLogs: vi.fn().mockResolvedValue('   \n  '),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', { generateArtifacts: false });

      const logs = getPersistedLogs();
      expect(logs).toContain('--- container logs');
      expect(logs).toContain('(no output)');
    });

    it('emits an unavailable note when fetching logs throws (container does not exist)', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockRejectedValue(new Error('Pull failed')),
        getContainerLogs: vi.fn().mockRejectedValue(new Error('No such container: web-app')),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', { generateArtifacts: false, pullImage: true });

      expect(mockDocker.getContainerLogs).toHaveBeenCalled();
      const logs = getPersistedLogs();
      expect(logs).toContain(`--- container logs unavailable (${service.containerName}): No such container: web-app ---`);
      // Deploy itself was marked failed.
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })
      );
    });

    it('captures container logs even when the deploy fails in the catch path', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockRejectedValue(new Error('Pull failed')),
        getContainerLogs: vi.fn().mockResolvedValue('crash trace line\n'),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', { generateArtifacts: false, pullImage: true });

      const logs = getPersistedLogs();
      expect(logs).toContain('--- container logs');
      expect(logs).toContain('crash trace line');
    });

    it('does not call getContainerLogs when no dockerClient could be created', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const getContainerLogsSpy = vi.fn();
      mockCreateDocker.mockResolvedValue({
        dockerClient: null,
        sshClient: null,
        error: 'no docker',
        // include a getContainerLogs spy on a separate object — should not be touched
        unusedDocker: { getContainerLogs: getContainerLogsSpy },
      } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', { generateArtifacts: false });

      expect(getContainerLogsSpy).not.toHaveBeenCalled();
      const logs = getPersistedLogs();
      // The container logs section is not emitted because dockerClient is null.
      expect(logs).not.toContain('--- container logs');
    });

    it('does not re-capture container logs in the catch block after a successful capture', async () => {
      // Regression test: previously, a post-success failure (e.g. recordTagDeployment
      // throwing after sshClient was disconnected) caused the catch block to invoke
      // captureContainerLogs again, producing a misleading "unavailable" note after
      // the already-captured real logs.
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      // Force the post-success path to throw AFTER captureContainerLogs has already
      // emitted real logs. service.update is called twice on the success path; make
      // the second call (status: 'running' after logs captured) throw.
      let svcUpdateCalls = 0;
      mockPrisma.service.update.mockImplementation(async () => {
        svcUpdateCalls += 1;
        if (svcUpdateCalls > 1) throw new Error('post-success failure');
        return {} as any;
      });

      const mockDocker = {
        pullImage: vi.fn().mockResolvedValue(undefined),
        restartContainer: vi.fn().mockResolvedValue(undefined),
        listContainers: vi.fn().mockResolvedValue([
          { id: 'c1', name: service.containerName, image: 'web-app:v2.0', status: 'Up', state: 'running' },
        ]),
        getContainerLogs: vi.fn().mockResolvedValue('first capture line\n'),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', {
        imageTag: 'v2.0',
        pullImage: true,
        generateArtifacts: false,
      });

      // getContainerLogs must be called exactly once — not re-invoked from catch.
      expect(mockDocker.getContainerLogs).toHaveBeenCalledTimes(1);
      const logs = getPersistedLogs();
      expect(logs).toContain('first capture line');
      // The misleading "unavailable" note must not appear after a successful capture.
      expect(logs).not.toContain('container logs unavailable');
    });

    it('uses settings.defaultLogLines as the tail value (not a hardcoded 100)', async () => {
      mockGetSystemSettings.mockResolvedValueOnce({ defaultLogLines: 250 } as any);

      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        pullImage: vi.fn().mockRejectedValue(new Error('Pull failed')),
        getContainerLogs: vi.fn().mockResolvedValue('ok\n'),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await deployService('svc-1', 'user-1', 'user-id-1', { generateArtifacts: false, pullImage: true });

      expect(mockDocker.getContainerLogs).toHaveBeenCalledWith(
        service.containerName,
        expect.objectContaining({ tail: 250, timestamps: true })
      );
      const logs = getPersistedLogs();
      expect(logs).toContain('last 250 lines');
    });
  });

  describe('getContainerLogs (exported)', () => {
    it('forwards tail/until/timestamps to the docker client', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);

      const mockDocker = {
        getContainerLogs: vi.fn().mockResolvedValue('log contents'),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      const out = await getContainerLogs('svc-1', {
        tail: 25,
        until: '2026-05-20T10:00:00Z',
        timestamps: true,
      });

      expect(out).toBe('log contents');
      expect(mockDocker.getContainerLogs).toHaveBeenCalledWith(
        service.containerName,
        { tail: 25, until: '2026-05-20T10:00:00Z', timestamps: true }
      );
    });

    it('defaults tail to 100 when no options passed', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);

      const mockDocker = {
        getContainerLogs: vi.fn().mockResolvedValue(''),
      };
      mockCreateDocker.mockResolvedValue({ dockerClient: mockDocker, sshClient: null, mode: 'socket' } as any);

      await getContainerLogs('svc-1');

      expect(mockDocker.getContainerLogs).toHaveBeenCalledWith(
        service.containerName,
        expect.objectContaining({ tail: 100 })
      );
    });

    it('throws when docker client creation fails', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);

      mockCreateDocker.mockResolvedValue({ dockerClient: null, sshClient: null, error: 'boom' } as any);

      await expect(getContainerLogs('svc-1')).rejects.toThrow(/boom|Failed to create Docker client/);
    });

    it('disconnects the SSH client after fetching logs', async () => {
      const service = createMockServiceData();
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);

      const mockDocker = {
        getContainerLogs: vi.fn().mockResolvedValue(''),
      };
      const mockSsh = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      };
      mockCreateDocker.mockResolvedValue({
        dockerClient: mockDocker,
        sshClient: mockSsh,
        needsConnect: true,
        mode: 'ssh',
      } as any);

      await getContainerLogs('svc-1');

      expect(mockSsh.connect).toHaveBeenCalled();
      expect(mockSsh.disconnect).toHaveBeenCalled();
    });
  });
});
