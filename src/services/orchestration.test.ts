import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveDependencyOrder } from './orchestration.js';
import type { Service, ServiceDependency } from '@prisma/client';

// ==================== Pure Function Tests (no DB needed) ====================

type ServiceWithDeps = Service & {
  dependencies: (ServiceDependency & { dependsOn: Service })[];
  dependents: (ServiceDependency & { dependent: Service })[];
  server: { name: string; hostname: string };
};

function makeService(
  id: string,
  name: string,
  deps: { dependsOnId: string; dependsOn: Partial<Service>; type?: string }[] = [],
  dependents: { dependentId: string; dependent: Partial<Service>; type?: string }[] = []
): ServiceWithDeps {
  return {
    id,
    name,
    containerName: name,
    imageTag: 'latest',
    imageName: `test/${name}`,
    serverId: 'server-1',
    environmentId: 'env-1',
    containerImageId: 'img-1',
    serviceTypeId: null,
    healthCheckUrl: null,
    healthWaitSeconds: 30,
    healthRetries: 3,
    healthIntervalSeconds: 10,
    tcpCheckPort: null,
    tcpCheckEnabled: false,
    certCheckEnabled: false,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    server: { name: 'test-server', hostname: 'test.local' },
    dependencies: deps.map((d, i) => ({
      id: `dep-${id}-${i}`,
      dependentId: id,
      dependsOnId: d.dependsOnId,
      type: d.type || 'deploy_after',
      createdAt: new Date(),
      dependsOn: {
        id: d.dependsOnId,
        name: d.dependsOn.name || d.dependsOnId,
        containerName: d.dependsOn.name || d.dependsOnId,
        imageTag: 'latest',
        imageName: `test/${d.dependsOn.name || d.dependsOnId}`,
        serverId: 'server-1',
        environmentId: 'env-1',
        containerImageId: 'img-1',
        serviceTypeId: null,
        healthCheckUrl: null,
        healthWaitSeconds: 30,
        healthRetries: 3,
        healthIntervalSeconds: 10,
        tcpCheckPort: null,
        tcpCheckEnabled: false,
        certCheckEnabled: false,
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Service,
    })) as (ServiceDependency & { dependsOn: Service })[],
    dependents: dependents.map((d, i) => ({
      id: `depnt-${id}-${i}`,
      dependentId: d.dependentId,
      dependsOnId: id,
      type: d.type || 'deploy_after',
      createdAt: new Date(),
      dependent: {
        id: d.dependentId,
        name: d.dependent.name || d.dependentId,
        containerName: d.dependent.name || d.dependentId,
        imageTag: 'latest',
        imageName: `test/${d.dependent.name || d.dependentId}`,
        serverId: 'server-1',
        environmentId: 'env-1',
        containerImageId: 'img-1',
        serviceTypeId: null,
        healthCheckUrl: null,
        healthWaitSeconds: 30,
        healthRetries: 3,
        healthIntervalSeconds: 10,
        tcpCheckPort: null,
        tcpCheckEnabled: false,
        certCheckEnabled: false,
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Service,
    })) as (ServiceDependency & { dependent: Service })[],
  } as ServiceWithDeps;
}

describe('resolveDependencyOrder', () => {
  it('returns empty array for empty input', () => {
    const result = resolveDependencyOrder([]);
    expect(result).toEqual([]);
  });

  it('returns single level for independent services', () => {
    const services = [
      makeService('a', 'service-a'),
      makeService('b', 'service-b'),
      makeService('c', 'service-c'),
    ];

    const levels = resolveDependencyOrder(services);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(3);
  });

  it('orders services by dependency chain', () => {
    // C depends on B, B depends on A
    const a = makeService('a', 'service-a');
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const c = makeService('c', 'service-c', [
      { dependsOnId: 'b', dependsOn: { name: 'service-b' } },
    ]);

    const levels = resolveDependencyOrder([a, b, c]);
    expect(levels).toHaveLength(3);
    expect(levels[0].map((s) => s.id)).toEqual(['a']);
    expect(levels[1].map((s) => s.id)).toEqual(['b']);
    expect(levels[2].map((s) => s.id)).toEqual(['c']);
  });

  it('groups parallel services at the same level', () => {
    // B and C both depend on A
    const a = makeService('a', 'service-a');
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const c = makeService('c', 'service-c', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);

    const levels = resolveDependencyOrder([a, b, c]);
    expect(levels).toHaveLength(2);
    expect(levels[0].map((s) => s.id)).toEqual(['a']);
    expect(levels[1].map((s) => s.id).sort()).toEqual(['b', 'c']);
  });

  it('handles diamond dependency pattern', () => {
    // D depends on B and C, B and C both depend on A
    const a = makeService('a', 'service-a');
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const c = makeService('c', 'service-c', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const d = makeService('d', 'service-d', [
      { dependsOnId: 'b', dependsOn: { name: 'service-b' } },
      { dependsOnId: 'c', dependsOn: { name: 'service-c' } },
    ]);

    const levels = resolveDependencyOrder([a, b, c, d]);
    expect(levels).toHaveLength(3);
    expect(levels[0].map((s) => s.id)).toEqual(['a']);
    expect(levels[1].map((s) => s.id).sort()).toEqual(['b', 'c']);
    expect(levels[2].map((s) => s.id)).toEqual(['d']);
  });

  it('detects simple circular dependency', () => {
    // A depends on B, B depends on A
    const a = makeService('a', 'service-a', [
      { dependsOnId: 'b', dependsOn: { name: 'service-b' } },
    ]);
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);

    expect(() => resolveDependencyOrder([a, b])).toThrow(/Circular dependency/);
  });

  it('detects transitive circular dependency', () => {
    // A -> B -> C -> A
    const a = makeService('a', 'service-a', [
      { dependsOnId: 'c', dependsOn: { name: 'service-c' } },
    ]);
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const c = makeService('c', 'service-c', [
      { dependsOnId: 'b', dependsOn: { name: 'service-b' } },
    ]);

    expect(() => resolveDependencyOrder([a, b, c])).toThrow(/Circular dependency/);
  });

  it('ignores dependencies on services not in the deployment set', () => {
    // B depends on A, but A is not in the deployment
    const b = makeService('b', 'service-b', [
      { dependsOnId: 'external', dependsOn: { name: 'external-service' } },
    ]);

    const levels = resolveDependencyOrder([b]);
    expect(levels).toHaveLength(1);
    expect(levels[0].map((s) => s.id)).toEqual(['b']);
  });

  it('handles single service', () => {
    const a = makeService('a', 'service-a');
    const levels = resolveDependencyOrder([a]);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(1);
    expect(levels[0][0].id).toBe('a');
  });

  it('handles complex multi-level dependency graph', () => {
    // Level 0: A, B (no deps)
    // Level 1: C depends on A, D depends on B
    // Level 2: E depends on C and D
    const a = makeService('a', 'service-a');
    const b = makeService('b', 'service-b');
    const c = makeService('c', 'service-c', [
      { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
    ]);
    const d = makeService('d', 'service-d', [
      { dependsOnId: 'b', dependsOn: { name: 'service-b' } },
    ]);
    const e = makeService('e', 'service-e', [
      { dependsOnId: 'c', dependsOn: { name: 'service-c' } },
      { dependsOnId: 'd', dependsOn: { name: 'service-d' } },
    ]);

    const levels = resolveDependencyOrder([a, b, c, d, e]);
    expect(levels).toHaveLength(3);
    expect(levels[0].map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(levels[1].map((s) => s.id).sort()).toEqual(['c', 'd']);
    expect(levels[2].map((s) => s.id)).toEqual(['e']);
  });

  it('preserves all services in output', () => {
    const services = [
      makeService('a', 'service-a'),
      makeService('b', 'service-b', [
        { dependsOnId: 'a', dependsOn: { name: 'service-a' } },
      ]),
    ];

    const levels = resolveDependencyOrder(services);
    const allIds = levels.flat().map((s) => s.id).sort();
    expect(allIds).toEqual(['a', 'b']);
  });
});

// ==================== DB-Dependent Tests ====================

// Mock all external dependencies
vi.mock('../lib/db.js', () => ({
  prisma: {
    service: { findMany: vi.fn() },
    deploymentPlan: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    deploymentPlanStep: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    containerImage: { findUnique: vi.fn() },
  },
}));

vi.mock('./deploy.js', () => ({
  deployService: vi.fn(),
}));

vi.mock('./health-verification.js', () => ({
  verifyServiceHealth: vi.fn(),
}));

vi.mock('./image-management.js', () => ({
  recordTagDeployment: vi.fn(),
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
import { deployService } from './deploy.js';
import { verifyServiceHealth } from './health-verification.js';
import { sendSystemNotification } from './notifications.js';
import { eventBus } from '../lib/event-bus.js';
import { buildDeploymentPlan, executePlan, rollbackPlan, cancelPlan } from './orchestration.js';

const mockPrisma = vi.mocked(prisma);
const mockDeployService = vi.mocked(deployService);
const mockVerifyHealth = vi.mocked(verifyServiceHealth);
const mockSendNotification = vi.mocked(sendSystemNotification);

describe('buildDeploymentPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when neither containerImageId nor serviceIds provided', async () => {
    await expect(
      buildDeploymentPlan({
        environmentId: 'env-1',
        imageTag: 'v1.0',
        triggerType: 'manual',
        triggeredBy: 'user-1',
      })
    ).rejects.toThrow('Either containerImageId or serviceIds must be provided');
  });

  it('throws when no services found', async () => {
    mockPrisma.service.findMany.mockResolvedValue([]);

    await expect(
      buildDeploymentPlan({
        environmentId: 'env-1',
        containerImageId: 'img-1',
        imageTag: 'v1.0',
        triggerType: 'manual',
        triggeredBy: 'user-1',
      })
    ).rejects.toThrow('No services found for deployment');
  });

  it('creates plan with deploy steps for services', async () => {
    const mockServices = [
      makeService('svc-1', 'web-app'),
    ];
    mockPrisma.service.findMany.mockResolvedValue(mockServices as any);

    const createdPlan = { id: 'plan-1', name: 'Deploy v1.0' };
    mockPrisma.deploymentPlan.create.mockResolvedValue(createdPlan as any);
    mockPrisma.deploymentPlanStep.create.mockResolvedValue({} as any);
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      ...createdPlan,
      steps: [{ id: 'step-1', order: 0, action: 'deploy' }],
    } as any);

    const plan = await buildDeploymentPlan({
      environmentId: 'env-1',
      containerImageId: 'img-1',
      imageTag: 'v1.0',
      triggerType: 'manual',
      triggeredBy: 'user-1',
    });

    expect(mockPrisma.deploymentPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          imageTag: 'v1.0',
          triggerType: 'manual',
          autoRollback: true,
        }),
      })
    );
    expect(plan.id).toBe('plan-1');
  });

  it('creates health check steps for services with health dependencies', async () => {
    const svc = makeService('svc-1', 'web-app', [], []);
    svc.dependencies = [{
      id: 'dep-1',
      dependentId: 'svc-1',
      dependsOnId: 'svc-0',
      type: 'health_before',
      createdAt: new Date(),
      dependsOn: {} as Service,
    }] as any;

    mockPrisma.service.findMany.mockResolvedValue([svc] as any);
    mockPrisma.deploymentPlan.create.mockResolvedValue({ id: 'plan-1' } as any);
    mockPrisma.deploymentPlanStep.create.mockResolvedValue({} as any);
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({ id: 'plan-1', steps: [] } as any);

    await buildDeploymentPlan({
      environmentId: 'env-1',
      serviceIds: ['svc-1'],
      imageTag: 'v1.0',
      triggerType: 'manual',
      triggeredBy: 'user-1',
    });

    // Should create both deploy and health_check steps
    expect(mockPrisma.deploymentPlanStep.create).toHaveBeenCalledTimes(2);
    const calls = mockPrisma.deploymentPlanStep.create.mock.calls;
    expect(calls[0][0].data.action).toBe('deploy');
    expect(calls[1][0].data.action).toBe('health_check');
  });
});

describe('executePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws if plan is not pending', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      status: 'running',
      steps: [],
    } as any);

    await expect(executePlan('plan-1')).rejects.toThrow('Plan is already running');
  });

  it('executes deploy steps sequentially and marks plan completed', async () => {
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      status: 'pending',
      environmentId: 'env-1',
      autoRollback: true,
      parallelExecution: false,
      imageTag: 'v1.0',
      steps: [
        { id: 'step-1', order: 0, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9', service: { id: 'svc-1', name: 'web-app' }, serviceId: 'svc-1' },
      ],
    };

    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue(plan as any);
    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);

    // Deploy succeeds
    mockDeployService.mockResolvedValue({
      deployment: { id: 'dep-1', status: 'success' },
      logs: 'Deployed OK',
    } as any);

    // After deploy step, check status
    mockPrisma.deploymentPlanStep.findUniqueOrThrow.mockResolvedValue({
      id: 'step-1',
      status: 'success',
    } as any);

    await executePlan('plan-1');

    // Plan marked running then completed
    expect(mockPrisma.deploymentPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'running' }),
      })
    );
    expect(mockPrisma.deploymentPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      })
    );

    // Per-service notifications are sent by deploy.ts, not orchestration
    // Orchestration should NOT send a duplicate plan-level success notification
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('triggers rollback on failure when autoRollback is enabled', async () => {
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      status: 'pending',
      environmentId: 'env-1',
      autoRollback: true,
      parallelExecution: false,
      imageTag: 'v1.0',
      steps: [
        { id: 'step-1', order: 0, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9', service: { id: 'svc-1', name: 'web-app' }, serviceId: 'svc-1' },
        { id: 'step-2', order: 1, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9', service: { id: 'svc-2', name: 'api' }, serviceId: 'svc-2' },
      ],
    };

    // First call for executePlan, second for rollbackPlan
    mockPrisma.deploymentPlan.findUniqueOrThrow
      .mockResolvedValueOnce(plan as any)
      .mockResolvedValueOnce({
        ...plan,
        steps: [
          { ...plan.steps[0], status: 'success', previousTag: 'v0.9', action: 'deploy', service: { id: 'svc-1', name: 'web-app' } },
          { ...plan.steps[1], status: 'failed', previousTag: 'v0.9', action: 'deploy', service: { id: 'svc-2', name: 'api' } },
        ],
      } as any);

    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);

    // First deploy succeeds
    mockDeployService
      .mockResolvedValueOnce({
        deployment: { id: 'dep-1', status: 'success' },
        logs: 'OK',
      } as any)
      // Second deploy fails
      .mockRejectedValueOnce(new Error('Deploy failed'))
      // Rollback deploy succeeds
      .mockResolvedValueOnce({
        deployment: { id: 'dep-3', status: 'success' },
        logs: 'Rolled back',
      } as any);

    // Step status checks during sequential execution
    mockPrisma.deploymentPlanStep.findUniqueOrThrow
      .mockResolvedValueOnce({ id: 'step-1', status: 'success' } as any)
      .mockResolvedValueOnce({ id: 'step-2', status: 'failed' } as any);

    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      ...plan,
      logs: 'existing logs',
      steps: [
        { ...plan.steps[0], status: 'success', previousTag: 'v0.9', action: 'deploy', service: { id: 'svc-1', name: 'web-app' } },
      ],
    } as any);

    await executePlan('plan-1');

    // Rollback should have been called - deployService called 3 times (2 deploys + 1 rollback)
    expect(mockDeployService).toHaveBeenCalledTimes(3);
  });

  it('marks plan as failed without rollback when autoRollback is disabled', async () => {
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      status: 'pending',
      environmentId: 'env-1',
      autoRollback: false,
      parallelExecution: false,
      imageTag: 'v1.0',
      steps: [
        { id: 'step-1', order: 0, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9', service: { id: 'svc-1', name: 'web-app' }, serviceId: 'svc-1' },
      ],
    };

    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue(plan as any);
    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);

    mockDeployService.mockRejectedValue(new Error('Deploy failed'));
    mockPrisma.deploymentPlanStep.findUniqueOrThrow.mockResolvedValue({
      id: 'step-1',
      status: 'failed',
      error: 'Deploy failed',
    } as any);

    await executePlan('plan-1');

    // Plan marked as failed
    expect(mockPrisma.deploymentPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      })
    );

    // Failure notification sent
    expect(mockSendNotification).toHaveBeenCalled();
  });
});

describe('cancelPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a pending plan', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      status: 'pending',
    } as any);
    mockPrisma.deploymentPlanStep.updateMany.mockResolvedValue({ count: 2 } as any);
    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);

    await cancelPlan('plan-1');

    expect(mockPrisma.deploymentPlanStep.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending' }),
        data: { status: 'skipped' },
      })
    );
    expect(mockPrisma.deploymentPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled' }),
      })
    );
  });

  it('throws when trying to cancel a completed plan', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      status: 'completed',
    } as any);

    await expect(cancelPlan('plan-1')).rejects.toThrow('Cannot cancel plan with status: completed');
  });
});

describe('rollbackPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rolls back successful deploy steps in reverse order', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      steps: [
        // Reverse order (desc by order)
        { id: 'step-2', order: 1, action: 'deploy', status: 'success', previousTag: 'v0.9', service: { id: 'svc-2', name: 'api' } },
        { id: 'step-1', order: 0, action: 'deploy', status: 'success', previousTag: 'v0.8', service: { id: 'svc-1', name: 'web' } },
      ],
    } as any);

    mockDeployService
      .mockResolvedValueOnce({ deployment: { id: 'd-1', status: 'success' }, logs: 'OK' } as any)
      .mockResolvedValueOnce({ deployment: { id: 'd-2', status: 'success' }, logs: 'OK' } as any);

    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);

    await rollbackPlan('plan-1');

    // Both steps rolled back
    expect(mockDeployService).toHaveBeenCalledTimes(2);

    // First rollback uses step-2's previous tag (reverse order)
    expect(mockDeployService).toHaveBeenCalledWith(
      'svc-2', 'rollback', 'user-1',
      expect.objectContaining({ imageTag: 'v0.9' })
    );
    expect(mockDeployService).toHaveBeenCalledWith(
      'svc-1', 'rollback', 'user-1',
      expect.objectContaining({ imageTag: 'v0.8' })
    );

    // Plan marked as rolled_back
    expect(mockPrisma.deploymentPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rolled_back' }),
      })
    );
  });

  it('skips health_check steps during rollback', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      steps: [
        { id: 'step-2', order: 1, action: 'health_check', status: 'success', previousTag: null, service: { id: 'svc-1', name: 'web' } },
        { id: 'step-1', order: 0, action: 'deploy', status: 'success', previousTag: 'v0.9', service: { id: 'svc-1', name: 'web' } },
      ],
    } as any);

    mockDeployService.mockResolvedValue({ deployment: { id: 'd-1', status: 'success' }, logs: 'OK' } as any);
    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);

    await rollbackPlan('plan-1');

    // Only deploy step rolled back, not health_check
    expect(mockDeployService).toHaveBeenCalledTimes(1);
  });

  it('skips steps without previousTag', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      steps: [
        { id: 'step-1', order: 0, action: 'deploy', status: 'success', previousTag: null, service: { id: 'svc-1', name: 'web' } },
      ],
    } as any);

    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);

    await rollbackPlan('plan-1');

    expect(mockDeployService).not.toHaveBeenCalled();
  });

  it('sends failure notification after rollback', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      steps: [],
    } as any);

    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);

    await rollbackPlan('plan-1');

    expect(mockSendNotification).toHaveBeenCalledWith(
      'system_deployment_failed',
      'env-1',
      expect.objectContaining({ rollback: true })
    );
  });
});
