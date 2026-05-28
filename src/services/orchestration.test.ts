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
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    containerImage: { findUnique: vi.fn() },
  },
}));

vi.mock('./deploy.js', () => ({
  deployService: vi.fn(),
  deployServiceDryRun: vi.fn(),
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
import { deployService, deployServiceDryRun } from './deploy.js';
import { verifyServiceHealth } from './health-verification.js';
import { sendSystemNotification } from './notifications.js';
import { eventBus } from '../lib/event-bus.js';
import {
  buildDeploymentPlan,
  executePlan,
  executePlanDryRun,
  rollbackPlan,
  cancelPlan,
} from './orchestration.js';

const mockPrisma = vi.mocked(prisma);
const mockDeployService = vi.mocked(deployService);
const mockDeployServiceDryRun = vi.mocked(deployServiceDryRun);
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

  it('creates plan with one deploy step per ServiceDeployment', async () => {
    // Service template with two per-server deployments → expect two deploy steps.
    const svc = makeService('svc-1', 'web-app');
    (svc as any).serviceDeployments = [
      { id: 'sd-1', server: { name: 'srv-a', hostname: 'a.local' } },
      { id: 'sd-2', server: { name: 'srv-b', hostname: 'b.local' } },
    ];
    mockPrisma.service.findMany.mockResolvedValue([svc] as any);

    const createdPlan = { id: 'plan-1', name: 'Deploy v1.0' };
    mockPrisma.deploymentPlan.create.mockResolvedValue(createdPlan as any);
    mockPrisma.deploymentPlanStep.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      ...createdPlan,
      steps: [
        { id: 'step-1', order: 0, action: 'deploy' },
        { id: 'step-2', order: 1, action: 'deploy' },
      ],
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
    // Fan-out: one deploy step per ServiceDeployment, both linked back to the same serviceId.
    const stepData = mockPrisma.deploymentPlanStep.createMany.mock.calls[0][0].data as any[];
    expect(stepData).toHaveLength(2);
    expect(stepData.map((s) => s.serviceDeploymentId).sort()).toEqual(['sd-1', 'sd-2']);
    expect(stepData.every((s) => s.serviceId === 'svc-1' && s.action === 'deploy')).toBe(true);
    expect(plan.id).toBe('plan-1');
  });

  it('creates health check steps per deployment for services with health dependencies', async () => {
    const svc = makeService('svc-1', 'web-app', [], []);
    svc.dependencies = [{
      id: 'dep-1',
      dependentId: 'svc-1',
      dependsOnId: 'svc-0',
      type: 'health_before',
      createdAt: new Date(),
      dependsOn: {} as Service,
    }] as any;
    // One deployment → expect deploy + health_check = 2 steps.
    (svc as any).serviceDeployments = [
      { id: 'sd-1', server: { name: 'srv-a', hostname: 'a.local' } },
    ];

    mockPrisma.service.findMany.mockResolvedValue([svc] as any);
    mockPrisma.deploymentPlan.create.mockResolvedValue({ id: 'plan-1' } as any);
    mockPrisma.deploymentPlanStep.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({ id: 'plan-1', steps: [] } as any);

    await buildDeploymentPlan({
      environmentId: 'env-1',
      serviceIds: ['svc-1'],
      imageTag: 'v1.0',
      triggerType: 'manual',
      triggeredBy: 'user-1',
    });

    // Should batch-create both deploy and health_check steps
    expect(mockPrisma.deploymentPlanStep.createMany).toHaveBeenCalledTimes(1);
    const data = mockPrisma.deploymentPlanStep.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(2);
    expect(data[0].action).toBe('deploy');
    expect(data[0].serviceDeploymentId).toBe('sd-1');
    expect(data[1].action).toBe('health_check');
    expect(data[1].serviceDeploymentId).toBe('sd-1');
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
    // 2.0: each step targets a ServiceDeployment (per-server), not a Service template directly.
    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      status: 'pending',
      environmentId: 'env-1',
      autoRollback: true,
      parallelExecution: false,
      imageTag: 'v1.0',
      steps: [
        {
          id: 'step-1', order: 0, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9',
          service: { id: 'svc-1', name: 'web-app' }, serviceId: 'svc-1',
          serviceDeploymentId: 'sd-1',
          serviceDeployment: {
            id: 'sd-1',
            server: { id: 'srv-1', name: 'srv-a' },
            service: { id: 'svc-1', name: 'web-app' },
          },
        },
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

    // deployService is called with the ServiceDeployment id (per-server), NOT the Service id.
    expect(mockDeployService).toHaveBeenCalledWith(
      'sd-1',
      expect.any(String),
      undefined,
      expect.objectContaining({ imageTag: 'v1.0' })
    );

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
    const buildStep = (id: string, order: number, sdId: string, svcId: string, svcName: string) => ({
      id, order, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9',
      service: { id: svcId, name: svcName }, serviceId: svcId,
      serviceDeploymentId: sdId,
      serviceDeployment: {
        id: sdId,
        server: { id: 'srv-1', name: 'srv-a' },
        service: { id: svcId, name: svcName },
      },
    });

    const plan = {
      id: 'plan-1',
      name: 'Test Plan',
      status: 'pending',
      environmentId: 'env-1',
      autoRollback: true,
      parallelExecution: false,
      imageTag: 'v1.0',
      steps: [
        buildStep('step-1', 0, 'sd-1', 'svc-1', 'web-app'),
        buildStep('step-2', 1, 'sd-2', 'svc-2', 'api'),
      ],
    };

    // First call for executePlan, second for rollbackPlan (steps in reverse order with statuses).
    mockPrisma.deploymentPlan.findUniqueOrThrow
      .mockResolvedValueOnce(plan as any)
      .mockResolvedValueOnce({
        ...plan,
        steps: [
          { ...plan.steps[1], status: 'failed' },
          { ...plan.steps[0], status: 'success' },
        ],
      } as any)
      .mockResolvedValueOnce({ ...plan, logs: 'existing logs', steps: [] } as any);

    mockPrisma.deploymentPlan.update.mockResolvedValue({} as any);
    mockPrisma.deploymentPlanStep.update.mockResolvedValue({} as any);

    // First deploy succeeds; second deploy throws; rollback deploy of step-1 succeeds.
    mockDeployService
      .mockResolvedValueOnce({ deployment: { id: 'dep-1', status: 'success' }, logs: 'OK' } as any)
      .mockRejectedValueOnce(new Error('Deploy failed'))
      .mockResolvedValueOnce({ deployment: { id: 'dep-3', status: 'success' }, logs: 'Rolled back' } as any);

    mockPrisma.deploymentPlanStep.findUniqueOrThrow
      .mockResolvedValueOnce({ id: 'step-1', status: 'success' } as any)
      .mockResolvedValueOnce({ id: 'step-2', status: 'failed' } as any);

    await executePlan('plan-1');

    // 2 deploys + 1 rollback = 3 deployService calls.
    expect(mockDeployService).toHaveBeenCalledTimes(3);
    // The rollback call targets the ServiceDeployment id (per-server), reusing previousTag.
    expect(mockDeployService).toHaveBeenCalledWith(
      'sd-1',
      'rollback',
      undefined,
      expect.objectContaining({ imageTag: 'v0.9' })
    );
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
        {
          id: 'step-1', order: 0, action: 'deploy', targetTag: 'v1.0', previousTag: 'v0.9',
          service: { id: 'svc-1', name: 'web-app' }, serviceId: 'svc-1',
          serviceDeploymentId: 'sd-1',
          serviceDeployment: {
            id: 'sd-1',
            server: { id: 'srv-1', name: 'srv-a' },
            service: { id: 'svc-1', name: 'web-app' },
          },
        },
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
    const buildStep = (id: string, order: number, sdId: string, svcId: string, svcName: string, previousTag: string | null, status: string = 'success', action: string = 'deploy') => ({
      id, order, action, status, previousTag,
      service: { id: svcId, name: svcName },
      serviceDeploymentId: sdId,
      serviceDeployment: {
        id: sdId,
        server: { id: 'srv-1', name: 'srv-a' },
        service: { id: svcId, name: svcName },
      },
    });

    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      logs: '',
      steps: [
        // Reverse order (desc by order)
        buildStep('step-2', 1, 'sd-2', 'svc-2', 'api', 'v0.9'),
        buildStep('step-1', 0, 'sd-1', 'svc-1', 'web', 'v0.8'),
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

    // First rollback (step-2, the most recent deploy) uses sd-2 and v0.9.
    expect(mockDeployService).toHaveBeenCalledWith(
      'sd-2', 'rollback', 'user-1',
      expect.objectContaining({ imageTag: 'v0.9' })
    );
    expect(mockDeployService).toHaveBeenCalledWith(
      'sd-1', 'rollback', 'user-1',
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
    const buildStep = (id: string, order: number, sdId: string, svcId: string, svcName: string, previousTag: string | null, status: string = 'success', action: string = 'deploy') => ({
      id, order, action, status, previousTag,
      service: { id: svcId, name: svcName },
      serviceDeploymentId: sdId,
      serviceDeployment: {
        id: sdId,
        server: { id: 'srv-1', name: 'srv-a' },
        service: { id: svcId, name: svcName },
      },
    });

    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Test Plan',
      environmentId: 'env-1',
      userId: 'user-1',
      logs: '',
      steps: [
        buildStep('step-2', 1, 'sd-1', 'svc-1', 'web', null, 'success', 'health_check'),
        buildStep('step-1', 0, 'sd-1', 'svc-1', 'web', 'v0.9'),
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

describe('executePlanDryRun (issue #128)', () => {
  // Critical invariants the dry-run path must honor:
  //   - Plan status is NOT transitioned (no `deploymentPlan.update`).
  //   - Step rows are NOT written (no `deploymentPlanStep.update`).
  //   - The live `deployService` is NEVER invoked — only `deployServiceDryRun`.
  // Everything else (ordering, building the report) is a pure transform over
  // what `deployServiceDryRun` returns, so we stub it deterministically.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDryRunReport(overrides: Partial<{ serviceDeploymentId: string; serverName: string; imageTag: string }> = {}) {
    return {
      dryRun: true as const,
      serviceId: 'svc-1',
      serviceDeploymentId: overrides.serviceDeploymentId ?? 'sd-1',
      serverName: overrides.serverName ?? 'srv-a',
      imageTag: overrides.imageTag ?? 'v1.0',
      imageDigest: 'sha256:abc123',
      composeContent: 'services: {}',
      env: {},
      containerAction: 'cycle' as const,
      warnings: [],
    };
  }

  it('does not transition plan status or write step rows', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Deploy v2.0',
      steps: [
        {
          id: 'step-1',
          order: 0,
          action: 'deploy',
          serviceDeployment: {
            id: 'sd-1',
            server: { name: 'srv-a' },
            service: { name: 'web' },
          },
        },
      ],
    } as any);
    mockDeployServiceDryRun.mockResolvedValue(makeDryRunReport({ serviceDeploymentId: 'sd-1' }));

    await executePlanDryRun('plan-1');

    // CRITICAL: no mutation to the plan or its steps.
    expect(mockPrisma.deploymentPlan.update).not.toHaveBeenCalled();
    expect(mockPrisma.deploymentPlanStep.update).not.toHaveBeenCalled();
    expect(mockPrisma.deploymentPlanStep.updateMany).not.toHaveBeenCalled();
    // CRITICAL: no live deploy attempted.
    expect(mockDeployService).not.toHaveBeenCalled();
    // No deployment lifecycle events emitted (dry-run is side-effect-free).
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
  });

  it('returns one step per deploy action in plan order with serviceName attached', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Multi-service rollout',
      steps: [
        {
          id: 'step-1',
          order: 0,
          action: 'deploy',
          serviceDeployment: {
            id: 'sd-a',
            server: { name: 'srv-a' },
            service: { name: 'web' },
          },
        },
        {
          id: 'step-2',
          order: 1,
          action: 'deploy',
          serviceDeployment: {
            id: 'sd-b',
            server: { name: 'srv-b' },
            service: { name: 'worker' },
          },
        },
      ],
    } as any);

    mockDeployServiceDryRun.mockImplementation(async (sdId: string) =>
      makeDryRunReport({ serviceDeploymentId: sdId })
    );

    const report = await executePlanDryRun('plan-1');

    expect(report.dryRun).toBe(true);
    expect(report.planId).toBe('plan-1');
    expect(report.planName).toBe('Multi-service rollout');
    expect(report.steps).toHaveLength(2);
    // Order matches the plan's step order (asc). serviceName is denormalized
    // onto each step so the caller doesn't need a separate join.
    expect(report.steps[0]).toMatchObject({
      stepOrder: 0,
      serviceName: 'web',
      serviceDeploymentId: 'sd-a',
    });
    expect(report.steps[1]).toMatchObject({
      stepOrder: 1,
      serviceName: 'worker',
      serviceDeploymentId: 'sd-b',
    });
    // The per-deployment dry-run was called once per deploy step, and the
    // step.targetTag is passed through so each preview reflects the planned
    // tag (not the current Service tag).
    expect(mockDeployServiceDryRun).toHaveBeenCalledTimes(2);
    expect(mockDeployServiceDryRun).toHaveBeenNthCalledWith(1, 'sd-a', { imageTag: undefined });
    expect(mockDeployServiceDryRun).toHaveBeenNthCalledWith(2, 'sd-b', { imageTag: undefined });
  });

  it('passes step.targetTag through to deployServiceDryRun so the preview matches what executePlan would deploy', async () => {
    // The live `executePlan` path passes `{ imageTag: step.targetTag }` into
    // `deployService`. The dry-run must mirror that — without this, the
    // preview would render the current Service.imageTag, NOT the tag the
    // real run would deploy.
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Deploy v2.0',
      steps: [
        {
          id: 'step-1',
          order: 0,
          action: 'deploy',
          targetTag: 'v2.0',
          serviceDeployment: {
            id: 'sd-1',
            server: { name: 'srv-a' },
            service: { name: 'web' },
          },
        },
      ],
    } as any);
    mockDeployServiceDryRun.mockResolvedValue(makeDryRunReport({ serviceDeploymentId: 'sd-1', imageTag: 'v2.0' }));

    const report = await executePlanDryRun('plan-1');

    expect(mockDeployServiceDryRun).toHaveBeenCalledWith('sd-1', { imageTag: 'v2.0' });
    expect(report.steps[0].imageTag).toBe('v2.0');
  });

  it('skips non-deploy steps (e.g. health_check) — only deploy actions get a dry-run report', async () => {
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Deploy with health check',
      steps: [
        {
          id: 'step-1',
          order: 0,
          action: 'deploy',
          serviceDeployment: {
            id: 'sd-a',
            server: { name: 'srv-a' },
            service: { name: 'web' },
          },
        },
        {
          id: 'step-2',
          order: 1,
          action: 'health_check',
          serviceDeployment: {
            id: 'sd-a',
            server: { name: 'srv-a' },
            service: { name: 'web' },
          },
        },
      ],
    } as any);
    mockDeployServiceDryRun.mockResolvedValue(makeDryRunReport({ serviceDeploymentId: 'sd-a' }));

    const report = await executePlanDryRun('plan-1');

    expect(report.steps).toHaveLength(1);
    expect(report.steps[0].stepOrder).toBe(0);
    expect(mockDeployServiceDryRun).toHaveBeenCalledTimes(1);
  });

  it('skips deploy steps that have no attached ServiceDeployment', async () => {
    // Defensive: a deploy step row missing its serviceDeployment relation
    // would otherwise crash when we read `step.serviceDeployment.id`.
    mockPrisma.deploymentPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      name: 'Plan with orphan step',
      steps: [
        {
          id: 'step-1',
          order: 0,
          action: 'deploy',
          serviceDeployment: null,
        },
      ],
    } as any);

    const report = await executePlanDryRun('plan-1');

    expect(report.steps).toEqual([]);
    expect(mockDeployServiceDryRun).not.toHaveBeenCalled();
  });
});
