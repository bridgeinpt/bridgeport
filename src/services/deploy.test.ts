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

vi.mock('./system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({ defaultLogLines: 50 }),
}));

import { prisma } from '../lib/db.js';
import { createDockerClientForServer } from '../lib/docker.js';
import { deployService, deployServiceTemplate, getDeploymentHistory, getContainerLogs } from './deploy.js';
import { getSystemSettings } from './system-settings.js';

const mockPrisma = vi.mocked(prisma);
const mockCreateDocker = vi.mocked(createDockerClientForServer);
const mockGetSystemSettings = vi.mocked(getSystemSettings);

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

/**
 * Alias factory used by the captureContainerLogs / getContainerLogs test blocks.
 * These tests refer to the row by `service.containerName` etc., so the alias
 * just returns a ServiceDeployment-shaped row matching the new (post-refactor)
 * Prisma query in `deployService` / `getContainerLogs`.
 */
function createMockServiceData() {
  return buildDeploymentRow();
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

  it('refuses to deploy a template with zero deployments and surfaces an error', async () => {
    // Zero-deployment templates used to "succeed" silently — see code-review
    // finding #6. The fan-out now refuses and returns a typed error so callers
    // (webhooks, deploy plans, CI release automation) treat the no-op rollout
    // as a failure instead of a green deploy.
    mockTemplate([], 'sequential');

    const out = await deployServiceTemplate('svc-1', 'user@test.com', 'user-1');

    expect(out.halted).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.error).toMatch(/no deployments/i);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
      mockPrisma.deployment.create.mockResolvedValue({ id: 'dep-1', status: 'running' } as any);
      mockPrisma.deployment.update.mockResolvedValue({ id: 'dep-1', status: 'failed' } as any);
      // Force the post-success path to throw AFTER captureContainerLogs has
      // already emitted real logs. captureContainerLogs runs on success at line
      // 275 of deploy.ts; the very next persistence call is
      // `prisma.serviceDeployment.update` (status: running) at line 284. Making
      // that throw drives execution into the catch block, which (per the bug
      // this test guards against) used to invoke captureContainerLogs a second
      // time against an already-disconnected client.
      mockPrisma.serviceDeployment.update.mockRejectedValueOnce(
        new Error('post-success failure')
      );

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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);
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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);

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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);

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
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);

      mockCreateDocker.mockResolvedValue({ dockerClient: null, sshClient: null, error: 'boom' } as any);

      await expect(getContainerLogs('svc-1')).rejects.toThrow(/boom|Failed to create Docker client/);
    });

    it('disconnects the SSH client after fetching logs', async () => {
      const service = createMockServiceData();
      mockPrisma.serviceDeployment.findUniqueOrThrow.mockResolvedValue(service as any);

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
