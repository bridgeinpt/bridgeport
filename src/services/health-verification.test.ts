import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/docker.js', () => ({
  createDockerClientForServer: vi.fn(),
}));

vi.mock('../lib/ssh.js', () => ({
  DockerSSH: vi.fn(),
  createClientForServer: vi.fn(),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn(),
}));

vi.mock('./servers.js', () => ({
  determineHealthStatus: vi.fn().mockReturnValue('healthy'),
  determineOverallStatus: vi.fn().mockReturnValue('running'),
}));

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { determineHealthStatus, determineOverallStatus } from './servers.js';
import { verifyServiceHealth, quickHealthCheck } from './health-verification.js';

const mockPrisma = vi.mocked(prisma);
const mockCreateDocker = vi.mocked(createDockerClientForServer);
const mockDetermineHealth = vi.mocked(determineHealthStatus);
const mockDetermineOverall = vi.mocked(determineOverallStatus);

function createMockService(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-1',
    name: 'web-app',
    containerName: 'web-app',
    healthCheckUrl: null,
    healthWaitMs: 0,
    healthRetries: 3,
    healthIntervalMs: 0, // No delay in tests
    server: {
      id: 'srv-1',
      name: 'test-server',
      hostname: 'test.local',
      dockerMode: 'socket',
      serverType: 'linux',
      environmentId: 'env-1',
      environment: {
        id: 'env-1',
        name: 'Test',
      },
    },
    ...overrides,
  };
}

describe('health-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: healthy
    mockDetermineHealth.mockReturnValue('healthy');
    mockDetermineOverall.mockReturnValue('running');
  });

  describe('verifyServiceHealth', () => {
    it('returns healthy when container is running', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(createMockService() as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      const mockDocker = {
        getContainerHealth: vi.fn().mockResolvedValue({
          state: 'running',
          status: 'Running',
          health: 'healthy',
          running: true,
        }),
      };
      mockCreateDocker.mockResolvedValue({
        dockerClient: mockDocker,
        sshClient: null,
        error: null,
        needsConnect: false,
      } as any);

      const result = await verifyServiceHealth({ serviceId: 'svc-1' });

      expect(result.healthy).toBe(true);
      expect(result.containerStatus).toBe('running');
    });

    it('retries when container health check fails initially', async () => {
      const service = createMockService({
        healthRetries: 2,
        healthIntervalMs: 0,
      });
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      // First call: unhealthy, second call: healthy
      mockDetermineHealth
        .mockReturnValueOnce('unhealthy')
        .mockReturnValueOnce('healthy');

      const mockDocker = {
        getContainerHealth: vi.fn()
          .mockResolvedValueOnce({
            state: 'starting',
            status: 'Starting',
            health: 'starting',
            running: true,
          })
          .mockResolvedValueOnce({
            state: 'running',
            status: 'Running',
            health: 'healthy',
            running: true,
          }),
      };
      mockCreateDocker.mockResolvedValue({
        dockerClient: mockDocker,
        sshClient: null,
        error: null,
        needsConnect: false,
      } as any);

      const result = await verifyServiceHealth({ serviceId: 'svc-1' });

      expect(result.healthy).toBe(true);
      expect(result.attempts).toBeGreaterThan(1);
    });

    it('returns unhealthy after all retries exhausted', async () => {
      const service = createMockService({
        healthRetries: 2,
        healthIntervalMs: 0,
      });
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.service.update.mockResolvedValue({} as any);

      mockDetermineHealth.mockReturnValue('unhealthy');

      const mockDocker = {
        getContainerHealth: vi.fn().mockResolvedValue({
          state: 'unhealthy',
          status: 'Unhealthy',
          health: 'unhealthy',
          running: true,
        }),
      };
      mockCreateDocker.mockResolvedValue({
        dockerClient: mockDocker,
        sshClient: null,
        error: null,
        needsConnect: false,
      } as any);

      const result = await verifyServiceHealth({ serviceId: 'svc-1' });

      expect(result.healthy).toBe(false);
      expect(result.attempts).toBeGreaterThanOrEqual(2);
    });

    it('returns unhealthy when Docker client creation fails', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(createMockService() as any);

      mockCreateDocker.mockResolvedValue({
        dockerClient: null,
        sshClient: null,
        error: 'Connection refused',
        needsConnect: false,
      } as any);

      const result = await verifyServiceHealth({ serviceId: 'svc-1' });

      expect(result.healthy).toBe(false);
    });
  });

  describe('quickHealthCheck', () => {
    it('returns health status for running container', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(createMockService() as any);

      const mockDocker = {
        getContainerHealth: vi.fn().mockResolvedValue({
          state: 'running',
          status: 'Running',
          health: 'healthy',
          running: true,
        }),
      };
      mockCreateDocker.mockResolvedValue({
        dockerClient: mockDocker,
        sshClient: null,
        error: null,
        needsConnect: false,
      } as any);

      const result = await quickHealthCheck('svc-1');

      expect(result.containerStatus).toBe('running');
      expect(result.running).toBe(true);
    });

    it('returns unknown on Docker error', async () => {
      mockPrisma.service.findUniqueOrThrow.mockResolvedValue(createMockService() as any);

      mockCreateDocker.mockResolvedValue({
        dockerClient: null,
        sshClient: null,
        error: 'Connection refused',
        needsConnect: false,
      } as any);

      const result = await quickHealthCheck('svc-1');

      expect(result.containerStatus).toBe('unknown');
      expect(result.running).toBe(false);
    });
  });
});
