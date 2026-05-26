import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies BEFORE importing the module under test.
vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    serviceDeployment: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    deployment: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    containerImage: { findUnique: vi.fn() },
    operationsSettings: { findUnique: vi.fn().mockResolvedValue({ autoPruneImages: false }) },
    imageDigest: { findUnique: vi.fn() },
  },
}));

vi.mock('../lib/docker.js', () => ({
  createDockerClientForServer: vi.fn(),
  DockerSSH: vi.fn(),
}));

vi.mock('../lib/ssh.js', () => ({
  createSSHClient: vi.fn(),
  DockerSSH: vi.fn(),
  shellEscape: vi.fn((s: string) => `'${s}'`),
}));

vi.mock('../lib/scheduler.js', () => ({
  checkServiceUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/registry.js', () => ({
  RegistryFactory: { create: vi.fn() },
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue('mock-key'),
}));

vi.mock('./compose.js', () => ({
  generateDeploymentArtifacts: vi.fn().mockResolvedValue({
    compose: { name: 'docker-compose.yml', content: 'services:', checksum: 'abc' },
    configFiles: [],
  }),
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

vi.mock('./registries.js', () => ({
  getRegistryCredentials: vi.fn(),
}));

vi.mock('./registry-login.js', () => ({
  ensureRegistryLogin: vi.fn().mockResolvedValue({ loggedIn: false }),
  getSocketAuthConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('./servers.js', () => ({
  pruneServerImages: vi.fn().mockResolvedValue({ spaceReclaimedBytes: 0 }),
}));

vi.mock('../lib/event-bus.js', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { deployService, deployServiceTemplate, getDeploymentHistory } from './deploy.js';

const mockPrisma = vi.mocked(prisma);
const mockCreateDocker = vi.mocked(createDockerClientForServer);

function buildDeploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dep-1',
    serviceId: 'svc-1',
    serverId: 'srv-1',
    containerName: 'web-app',
    composePath: null,
    envOverrides: null,
    exposedPorts: null,
    status: 'unknown',
    server: {
      id: 'srv-1',
      name: 'prod',
      hostname: 'prod.local',
      dockerMode: 'socket',
      serverType: 'remote',
      environmentId: 'env-1',
      environment: { id: 'env-1', name: 'Test', sshPrivateKey: null },
    },
    service: {
      id: 'svc-1',
      name: 'web-app',
      imageTag: 'v1.0',
      composeTemplate: null,
      baseEnv: null,
      environmentId: 'env-1',
      containerImageId: 'img-1',
      containerImage: {
        id: 'img-1',
        imageName: 'registry.com/web-app',
        tagFilter: 'v1.0',
        registryConnectionId: null,
      },
    },
    ...overrides,
  };
}

describe('deployService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('looks up the ServiceDeployment (not Service) and creates a deployment row', async () => {
    mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(buildDeploymentRow() as any);
    mockPrisma.deployment.create.mockResolvedValue({ id: 'dpl-1', status: 'pending' } as any);
    mockPrisma.deployment.update.mockResolvedValue({ id: 'dpl-1', status: 'success' } as any);
    mockPrisma.serviceDeployment.update.mockResolvedValue({} as any);

    const mockDocker = {
      pullImage: vi.fn().mockResolvedValue(undefined),
      restartContainer: vi.fn().mockResolvedValue(undefined),
      listContainers: vi.fn().mockResolvedValue([{ name: 'web-app', state: 'running' }]),
    };
    mockCreateDocker.mockResolvedValue({
      dockerClient: mockDocker,
      sshClient: null,
      mode: 'socket',
      needsConnect: false,
    } as any);

    const result = await deployService('dep-1', 'user@test.com', 'user-1', {
      imageTag: 'v2.0',
      pullImage: true,
      generateArtifacts: false,
    });

    expect(mockPrisma.serviceDeployment.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dep-1' } })
    );
    expect(mockPrisma.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceId: 'svc-1',
          serviceDeploymentId: 'dep-1',
          imageTag: 'v2.0',
        }),
      })
    );
    expect(result.deployment).toBeDefined();
  });

  it('marks deployment as failed on Docker error', async () => {
    mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(buildDeploymentRow() as any);
    mockPrisma.deployment.create.mockResolvedValue({ id: 'dpl-1', status: 'pending' } as any);
    mockPrisma.deployment.update.mockResolvedValue({ id: 'dpl-1', status: 'failed' } as any);

    mockCreateDocker.mockResolvedValue({
      dockerClient: {
        pullImage: vi.fn().mockRejectedValue(new Error('Pull failed')),
      },
      sshClient: null,
      mode: 'socket',
      needsConnect: false,
    } as any);

    const result = await deployService('dep-1', 'user@test.com', 'user-1', {
      imageTag: 'v2.0',
      pullImage: true,
      generateArtifacts: false,
    });

    expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
    // Even on failure, function resolves with a result (caller inspects status).
    expect(result.deployment).toBeDefined();
  });
});

describe('deployServiceTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTemplate(deployments: Array<{ id: string }>, deployStrategy: 'sequential' | 'parallel' = 'sequential') {
    mockPrisma.service.findUniqueOrThrow.mockResolvedValue({
      id: 'svc-1',
      name: 'web-app',
      deployStrategy,
      serviceDeployments: deployments,
    } as any);
  }

  /**
   * Helper: stub deployService results. Each entry is one of:
   *  - { status: 'success' }     → resolves with success
   *  - { status: 'failed' }      → resolves with failed (NOT thrown)
   *  - { throw: 'message' }      → rejects with Error(message)
   *
   * Trick: we identify which deployment we're currently processing by binding the
   * id at findUniqueOrThrow time and threading it through createDockerClientForServer
   * via a deployment-specific stub. Each createDocker call gets a fresh mock whose
   * methods know which id this deploy is for — safe under parallel execution.
   */
  function stubDeployResults(
    deploymentIds: string[],
    outcomes: Array<{ status?: 'success' | 'failed'; throw?: string }>
  ) {
    const outcomeById = new Map(deploymentIds.map((id, i) => [id, outcomes[i]]));
    // Pending bindings: queue of (id) the next createDockerClientForServer call will use.
    // findUniqueOrThrow pushes; createDockerClientForServer shifts. Order is preserved
    // because deployService is synchronous between those calls (no awaits in between
    // that would let another deployment slip in). Actually that's true even in parallel:
    // each `deployService` chain's synchronous bit between findUniqueOrThrow and
    // createDockerClientForServer keeps the pairing intact for V8's microtask queue.
    const pendingIds: string[] = [];

    mockPrisma.serviceDeployment.findUniqueOrThrow.mockImplementation(
      async ({ where }: any) => {
        pendingIds.push(where.id);
        return buildDeploymentRow({ id: where.id, serviceId: 'svc-1' }) as any;
      }
    );
    mockPrisma.deployment.create.mockImplementation(async ({ data }: any) => ({
      id: `dpl-${data.serviceDeploymentId}`,
      status: data.status,
      serviceDeploymentId: data.serviceDeploymentId,
    } as any));

    mockPrisma.deployment.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    } as any));
    mockPrisma.serviceDeployment.update.mockResolvedValue({} as any);

    mockCreateDocker.mockImplementation(async () => {
      const id = pendingIds.shift()!;
      const outcome = outcomeById.get(id);
      const dep = buildDeploymentRow({ id });

      return {
        dockerClient: {
          pullImage: vi.fn().mockImplementation(async () => {
            if (outcome?.throw) throw new Error(outcome.throw);
            if (outcome?.status === 'failed') throw new Error('simulated failed deploy');
            return undefined;
          }),
          restartContainer: vi.fn().mockResolvedValue(undefined),
          listContainers: vi.fn().mockResolvedValue([
            { name: dep.containerName, state: 'running' },
          ]),
        },
        sshClient: null,
        mode: 'socket',
        needsConnect: false,
      } as any;
    });
  }

  it('uses the service.deployStrategy when options.strategy is unset', async () => {
    mockTemplate([{ id: 'dep-a' }, { id: 'dep-b' }], 'sequential');
    stubDeployResults(['dep-a', 'dep-b'], [{ status: 'success' }, { status: 'success' }]);

    const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1', { generateArtifacts: false, pullImage: true });

    // Sequential: 2 deploys, neither failed → not halted.
    expect(out.halted).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].serviceDeploymentId).toBe('dep-a');
    expect(out.results[1].serviceDeploymentId).toBe('dep-b');
  });

  it('options.strategy overrides service.deployStrategy', async () => {
    mockTemplate([{ id: 'dep-a' }, { id: 'dep-b' }], 'sequential');
    stubDeployResults(['dep-a', 'dep-b'], [{ status: 'success' }, { status: 'success' }]);

    const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1', {
      strategy: 'parallel',
      generateArtifacts: false,
      pullImage: true,
    });

    expect(out.halted).toBe(false);
    expect(out.results).toHaveLength(2);
    // In parallel mode, all deploys must run regardless of order.
    const ids = out.results.map((r) => r.serviceDeploymentId).sort();
    expect(ids).toEqual(['dep-a', 'dep-b']);
  });

  describe('sequential strategy', () => {
    it('halts on first failure and does NOT deploy subsequent deployments', async () => {
      mockTemplate([{ id: 'dep-a' }, { id: 'dep-b' }, { id: 'dep-c' }], 'sequential');
      stubDeployResults(
        ['dep-a', 'dep-b', 'dep-c'],
        [{ status: 'success' }, { status: 'failed' }, { status: 'success' }]
      );

      const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1', { generateArtifacts: false, pullImage: true });

      expect(out.halted).toBe(true);
      // Only A and B were attempted; C was skipped.
      expect(out.results).toHaveLength(2);
      expect(out.results[0].serviceDeploymentId).toBe('dep-a');
      expect(out.results[1].serviceDeploymentId).toBe('dep-b');
      // The failed result preserves rollback context (previousTag) for the caller to act on.
      expect(out.results[1].result?.deployment.status).toBe('failed');
      expect(out.results[1].result?.previousTag).toBe('v1.0');
    });

    it('halts and records an error when deployService throws (not just returns failed)', async () => {
      mockTemplate([{ id: 'dep-a' }, { id: 'dep-b' }], 'sequential');
      stubDeployResults(
        ['dep-a', 'dep-b'],
        [{ throw: 'fatal connection error' }, { status: 'success' }]
      );

      // First deployment throws during the listContainers/createDockerClientForServer setup.
      // Wait - actually our stub throws inside pullImage which is caught in deployService.
      // We need a throw that propagates OUT of deployService. Force it by making
      // serviceDeployment.findUniqueOrThrow reject for dep-a.
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockImplementation(async ({ where }: any) => {
        if (where.id === 'dep-a') throw new Error('fatal connection error');
        return buildDeploymentRow({ id: where.id });
      });

      const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1', { generateArtifacts: false, pullImage: true });

      expect(out.halted).toBe(true);
      expect(out.results).toHaveLength(1);
      expect(out.results[0]).toEqual(
        expect.objectContaining({
          serviceDeploymentId: 'dep-a',
          result: null,
          error: expect.stringContaining('fatal connection error'),
        })
      );
    });
  });

  describe('parallel strategy', () => {
    it('runs all deployments regardless of failures and aggregates statuses', async () => {
      mockTemplate([{ id: 'dep-a' }, { id: 'dep-b' }, { id: 'dep-c' }], 'parallel');
      stubDeployResults(
        ['dep-a', 'dep-b', 'dep-c'],
        [{ status: 'failed' }, { status: 'success' }, { status: 'success' }]
      );

      const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1', {
        strategy: 'parallel',
        generateArtifacts: false,
        pullImage: true,
      });

      // Parallel does NOT set halted (it uses Promise.allSettled semantics).
      expect(out.halted).toBe(false);
      expect(out.results).toHaveLength(3);

      const byId = new Map(out.results.map((r) => [r.serviceDeploymentId, r]));
      expect(byId.get('dep-a')?.result?.deployment.status).toBe('failed');
      expect(byId.get('dep-b')?.result?.deployment.status).toBe('success');
      expect(byId.get('dep-c')?.result?.deployment.status).toBe('success');
    });
  });

  it('returns an empty result set when the template has no deployments', async () => {
    mockTemplate([], 'sequential');

    const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1');

    expect(out.halted).toBe(false);
    expect(out.results).toEqual([]);
  });
});

describe('getDeploymentHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns deployment history for a service', async () => {
    mockPrisma.deployment.findMany.mockResolvedValue([
      { id: 'dep-1', status: 'success', startedAt: new Date() },
      { id: 'dep-2', status: 'failed', startedAt: new Date() },
    ] as any);

    const history = await getDeploymentHistory('svc-1');

    expect(history).toHaveLength(2);
    expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceId: 'svc-1' } })
    );
  });
});
