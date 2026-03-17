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

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { deployService, getDeploymentHistory } from './deploy.js';

const mockPrisma = vi.mocked(prisma);
const mockCreateDocker = vi.mocked(createDockerClientForServer);

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
});
