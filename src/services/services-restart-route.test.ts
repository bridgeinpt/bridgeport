/**
 * Unit tests for the `POST /api/services/:id/deployments/:depId/restart` route's
 * compose-vs-container branching.
 *
 * The route file under test is `src/routes/services.ts`. We exercise the route
 * via a minimal Fastify app rather than `buildTestApp()` so we can mock the SSH
 * / Docker layer cleanly — this lives in `src/services/` only so the unit-test
 * Vitest config picks it up (it requires `vi.mock` + `isolate: true` to avoid
 * leaking module mocks into the integration suite).
 *
 * Note: post the Service-template + per-server-ServiceDeployment split (PR #107),
 * restart targets a specific deployment, not the parent template. The route
 * queries `prisma.serviceDeployment.findUnique(...)` and reads runtime fields
 * (containerName, composePath, server) from the deployment row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const {
  mockPrisma,
  mockClient,
  mockDocker,
  createClientForServerMock,
} = vi.hoisted(() => ({
  mockPrisma: {
    service: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // After the per-server-deployment split, restart targets a specific
    // ServiceDeployment, so the route under test reads from this delegate.
    serviceDeployment: {
      findUnique: vi.fn(),
    },
    server: {
      findUnique: vi.fn(),
    },
    containerImage: {
      findUnique: vi.fn(),
    },
    deployment: {
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
  },
  mockClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
    execStream: vi.fn(),
    writeFile: vi.fn(),
  },
  mockDocker: {
    restartContainer: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    composeUp: vi.fn().mockResolvedValue(undefined),
  },
  createClientForServerMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
  isPrismaNotFoundError: () => false,
}));

vi.mock('../lib/ssh.js', () => ({
  // Use a function expression (not arrow) so it's `new`-able.
  DockerSSH: vi.fn(function DockerSSH() {
    return mockDocker;
  }) as unknown as new () => unknown,
  createClientForServer: createClientForServerMock,
  shellEscape: (v: string) => `'${v.replace(/'/g, `'\\''`)}'`,
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi
    .fn()
    .mockResolvedValue({ username: 'root', privateKey: 'fake-key' }),
}));

vi.mock('../services/deploy.js', () => ({
  deployService: vi.fn(),
  getDeploymentHistory: vi.fn(),
  getDeployment: vi.fn(),
  getContainerLogs: vi.fn(),
  getLatestImageTags: vi.fn(),
}));

vi.mock('../services/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  actorFrom: vi.fn().mockReturnValue({ userId: 'u-1', userEmail: 'u@test' }),
}));

vi.mock('../services/auth.js', () => ({
  userIdForFk: vi.fn().mockReturnValue('u-1'),
}));

vi.mock('../services/health-checks.js', () => ({
  logHealthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/scheduler.js', () => ({
  checkServiceUpdate: vi.fn(),
}));

vi.mock('../services/servers.js', () => ({
  determineHealthStatus: vi.fn(),
  determineOverallStatus: vi.fn(),
}));

vi.mock('../services/system-settings.js', () => ({
  getSystemSettings: vi
    .fn()
    .mockResolvedValue({ defaultLogLines: 100, publicUrl: '' }),
}));

import { serviceRoutes } from '../routes/services.js';

async function buildAppWithRestart(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Stub authenticate decorator — tests bypass JWT.
  app.decorate(
    'authenticate',
    async (request: any) => {
      request.authUser = { id: 'u-1', email: 'u@test', role: 'admin' };
    }
  );
  await app.register(serviceRoutes);
  await app.ready();
  return app;
}

describe('POST /api/services/:id/deployments/:depId/restart — compose vs container branch', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    createClientForServerMock.mockResolvedValue({ client: mockClient });
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.exec.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockDocker.restartContainer.mockResolvedValue(undefined);
    mockDocker.composeDown.mockResolvedValue(undefined);
    mockDocker.composeUp.mockResolvedValue(undefined);

    app = await buildAppWithRestart();
  });

  /**
   * Build a ServiceDeployment row in the shape Prisma returns for the route's
   * `serviceDeployment.findUnique({ include: { server: true, service: { select: { name, environmentId } } } })`.
   * Runtime fields (containerName, composePath, server) live on the deployment;
   * the parent template only contributes name + environmentId.
   */
  function deploymentFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'dep-1',
      serviceId: 'svc-1',
      serverId: 'srv-1',
      containerName: 'web-container',
      composePath: null,
      server: {
        id: 'srv-1',
        name: 'srv',
        hostname: '10.0.0.1',
        environmentId: 'env-1',
        serverType: 'standard',
      },
      service: {
        name: 'web',
        environmentId: 'env-1',
      },
      ...overrides,
    };
  }

  it('runs composeDown + composeUp(forceRecreate=true) when composePath is set, and DOES NOT restart the container', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(
      deploymentFixture({ composePath: '/srv/web/docker-compose.yml' })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/dep-1/restart',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    expect(mockDocker.composeDown).toHaveBeenCalledTimes(1);
    expect(mockDocker.composeDown).toHaveBeenCalledWith(
      '/srv/web/docker-compose.yml',
      'web-container'
    );

    expect(mockDocker.composeUp).toHaveBeenCalledTimes(1);
    expect(mockDocker.composeUp).toHaveBeenCalledWith(
      '/srv/web/docker-compose.yml',
      'web-container',
      true // forceRecreate must be true
    );

    // Critically: plain docker restart must NOT have run on the compose path.
    expect(mockDocker.restartContainer).not.toHaveBeenCalled();
  });

  it('runs restartContainer when composePath is null, and does NOT touch compose helpers', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(
      deploymentFixture({ composePath: null })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/dep-1/restart',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    expect(mockDocker.restartContainer).toHaveBeenCalledTimes(1);
    expect(mockDocker.restartContainer).toHaveBeenCalledWith('web-container');

    expect(mockDocker.composeDown).not.toHaveBeenCalled();
    expect(mockDocker.composeUp).not.toHaveBeenCalled();
  });

  it('returns 500 with an error message when the compose flow throws', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(
      deploymentFixture({ composePath: '/srv/web/docker-compose.yml' })
    );
    mockDocker.composeUp.mockRejectedValue(new Error('Failed to run compose up: boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/dep-1/restart',
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('Failed to run compose up');
  });

  it('returns 500 with an error message when the docker restart flow throws', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(
      deploymentFixture({ composePath: null })
    );
    mockDocker.restartContainer.mockRejectedValue(
      new Error('Failed to restart container: not found')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/dep-1/restart',
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('Failed to restart container');
  });

  it('returns 400 when createClientForServer fails (no SSH key)', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(deploymentFixture());
    createClientForServerMock.mockResolvedValue({
      client: null,
      error: 'SSH key not configured for this environment',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/dep-1/restart',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('SSH key not configured');
    // Neither path should have run.
    expect(mockDocker.restartContainer).not.toHaveBeenCalled();
    expect(mockDocker.composeUp).not.toHaveBeenCalled();
  });

  it('returns 404 when the deployment does not exist', async () => {
    mockPrisma.serviceDeployment.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/services/svc-1/deployments/missing/restart',
    });

    expect(res.statusCode).toBe(404);
    expect(mockDocker.restartContainer).not.toHaveBeenCalled();
    expect(mockDocker.composeUp).not.toHaveBeenCalled();
  });
});
