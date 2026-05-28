import { prisma } from '../lib/db.js';
import { deployService, deployServiceDryRun } from './deploy.js';
import { verifyServiceHealth } from './health-verification.js';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';
import { eventBus } from '../lib/event-bus.js';
import { DEPLOYMENT_STATUS, PLAN_STATUS, STEP_STATUS } from '../lib/constants.js';
import type { DeploymentPlan, DeploymentPlanStep, Server, Service, ServiceDependency, ServiceDeployment } from '@prisma/client';
import type { PlanDryRunReport } from '../lib/dry-run.js';

export interface BuildPlanOptions {
  environmentId: string;
  containerImageId?: string;
  serviceIds?: string[];
  imageTag: string;
  triggerType: 'manual' | 'webhook' | 'auto_update';
  triggeredBy: string;
  userId?: string;
  autoRollback?: boolean;
  parallelExecution?: boolean;
}

type ServiceWithDeps = Service & {
  dependencies: (ServiceDependency & { dependsOn: Service })[];
  dependents: (ServiceDependency & { dependent: Service })[];
  serviceDeployments: (ServiceDeployment & { server: { name: string; hostname: string } })[];
};

/**
 * Minimal shape `resolveDependencyOrder` actually reads — just `id`, `name`
 * (used in cycle-error messages), and the `dependsOnId` of each dependency.
 * Existing fat callers still satisfy this structurally; tight callers (like
 * the dependency-graph endpoint) can query with a narrow `select`.
 */
type ServiceOrderInput = {
  id: string;
  name: string;
  dependencies: { dependsOnId: string }[];
};

/**
 * Detect cycles in the dependency graph using DFS
 */
function detectCycle(
  services: Map<string, ServiceOrderInput>,
  serviceId: string,
  visited: Set<string>,
  recursionStack: Set<string>
): string[] | null {
  visited.add(serviceId);
  recursionStack.add(serviceId);

  const service = services.get(serviceId);
  if (!service) return null;

  for (const dep of service.dependencies) {
    const depId = dep.dependsOnId;

    if (!visited.has(depId)) {
      const cycle = detectCycle(services, depId, visited, recursionStack);
      if (cycle) {
        cycle.unshift(service.name);
        return cycle;
      }
    } else if (recursionStack.has(depId)) {
      const depService = services.get(depId);
      return [service.name, depService?.name || depId];
    }
  }

  recursionStack.delete(serviceId);
  return null;
}

/**
 * Topological sort using Kahn's algorithm
 * Returns services grouped by their level (services at same level can deploy in parallel)
 */
export function resolveDependencyOrder<T extends ServiceOrderInput>(services: T[]): T[][] {
  if (services.length === 0) return [];

  const serviceMap = new Map<string, T>();
  const inDegree = new Map<string, number>();
  const adjacencyList = new Map<string, string[]>();

  for (const service of services) {
    serviceMap.set(service.id, service);
    inDegree.set(service.id, 0);
    adjacencyList.set(service.id, []);
  }

  for (const service of services) {
    for (const dep of service.dependencies) {
      if (serviceMap.has(dep.dependsOnId)) {
        inDegree.set(service.id, (inDegree.get(service.id) || 0) + 1);
        const adj = adjacencyList.get(dep.dependsOnId) || [];
        adj.push(service.id);
        adjacencyList.set(dep.dependsOnId, adj);
      }
    }
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  for (const service of services) {
    if (!visited.has(service.id)) {
      const cycle = detectCycle(serviceMap, service.id, visited, recursionStack);
      if (cycle) {
        throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
      }
    }
  }

  const levels: T[][] = [];
  let queue = services.filter((s) => inDegree.get(s.id) === 0);

  while (queue.length > 0) {
    levels.push(queue);
    const nextQueue: T[] = [];

    for (const service of queue) {
      const dependents = adjacencyList.get(service.id) || [];
      for (const depId of dependents) {
        const newDegree = (inDegree.get(depId) || 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          const depService = serviceMap.get(depId);
          if (depService) nextQueue.push(depService);
        }
      }
    }

    queue = nextQueue;
  }

  const processedCount = levels.reduce((sum, level) => sum + level.length, 0);
  if (processedCount !== services.length) {
    throw new Error('Dependency resolution failed: not all services could be ordered');
  }

  return levels;
}

/**
 * Build a deployment plan. Plan steps now target individual ServiceDeployments;
 * each Service template fans out to one step per deployment.
 */
export async function buildDeploymentPlan(options: BuildPlanOptions): Promise<DeploymentPlan> {
  let services: ServiceWithDeps[];

  if (options.containerImageId) {
    services = await prisma.service.findMany({
      where: { containerImageId: options.containerImageId },
      include: {
        serviceDeployments: { include: { server: { select: { name: true, hostname: true } } } },
        dependencies: { include: { dependsOn: true } },
        dependents: { include: { dependent: true } },
      },
    });
  } else if (options.serviceIds && options.serviceIds.length > 0) {
    services = await prisma.service.findMany({
      where: { id: { in: options.serviceIds } },
      include: {
        serviceDeployments: { include: { server: { select: { name: true, hostname: true } } } },
        dependencies: { include: { dependsOn: true } },
        dependents: { include: { dependent: true } },
      },
    });
  } else {
    throw new Error('Either containerImageId or serviceIds must be provided');
  }

  if (services.length === 0) {
    throw new Error('No services found for deployment');
  }

  // Refuse to build a plan when any selected service has zero ServiceDeployments.
  // Otherwise the plan would have no steps, executePlan would mark it COMPLETED,
  // and CI/release automation would believe the rollout shipped.
  const empty = services.filter((s) => s.serviceDeployments.length === 0).map((s) => s.name);
  if (empty.length > 0) {
    throw new Error(
      `Cannot build deployment plan — the following services have no deployments attached: ${empty.join(', ')}. Add at least one server before deploying.`
    );
  }

  const orderedLevels = resolveDependencyOrder(services);

  const serviceNames = services.map((s) => s.name).slice(0, 3);
  const planName = options.containerImageId
    ? `Deploy ${options.imageTag}`
    : `Deploy ${serviceNames.join(', ')}${services.length > 3 ? '...' : ''}`;

  const plan = await prisma.deploymentPlan.create({
    data: {
      name: planName,
      status: PLAN_STATUS.PENDING,
      imageTag: options.imageTag,
      triggerType: options.triggerType,
      triggeredBy: options.triggeredBy,
      autoRollback: options.autoRollback ?? true,
      parallelExecution: options.parallelExecution ?? false,
      environmentId: options.environmentId,
      containerImageId: options.containerImageId,
      userId: options.userId,
    },
  });

  let stepOrder = 0;
  const stepsToCreate: {
    deploymentPlanId: string;
    serviceId: string;
    serviceDeploymentId: string;
    order: number;
    action: string;
    targetTag: string;
    previousTag: string | null;
  }[] = [];

  for (const level of orderedLevels) {
    for (const service of level) {
      const hasHealthDependency = service.dependencies.some((d) => d.type === 'health_before');

      // One deploy/health-check step per ServiceDeployment.
      for (const sd of service.serviceDeployments) {
        stepsToCreate.push({
          deploymentPlanId: plan.id,
          serviceId: service.id,
          serviceDeploymentId: sd.id,
          order: stepOrder++,
          action: 'deploy',
          targetTag: options.imageTag,
          previousTag: service.imageTag,
        });

        if (hasHealthDependency || service.healthCheckUrl) {
          stepsToCreate.push({
            deploymentPlanId: plan.id,
            serviceId: service.id,
            serviceDeploymentId: sd.id,
            order: stepOrder++,
            action: 'health_check',
            targetTag: options.imageTag,
            previousTag: service.imageTag,
          });
        }
      }
    }
  }

  await prisma.deploymentPlanStep.createMany({ data: stepsToCreate });

  return prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: plan.id },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
}

type StepWithDeployment = DeploymentPlanStep & {
  service: Service | null;
  serviceDeployment: (ServiceDeployment & { server: Server; service: Service }) | null;
};

function groupStepsByLevel(
  steps: StepWithDeployment[]
): Map<number, StepWithDeployment[]> {
  const levels = new Map<number, StepWithDeployment[]>();

  for (const step of steps) {
    const level = step.order;
    if (!levels.has(level)) {
      levels.set(level, []);
    }
    levels.get(level)!.push(step);
  }

  return levels;
}

/**
 * Execute a deployment plan step by step (or in parallel if enabled)
 */
export async function executePlan(planId: string): Promise<void> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        include: {
          service: true,
          serviceDeployment: { include: { server: true, service: true } },
        },
      },
      containerImage: true,
      environment: true,
    },
  });

  if (plan.status !== PLAN_STATUS.PENDING) {
    throw new Error(`Plan is already ${plan.status}`);
  }

  await prisma.deploymentPlan.update({
    where: { id: planId },
    data: { status: PLAN_STATUS.RUNNING, startedAt: new Date() },
  });

  for (const step of plan.steps) {
    if (step.service && step.action === 'deploy') {
      eventBus.emitEvent({ type: 'deployment_progress', data: { planId, serviceId: step.service.id, status: PLAN_STATUS.RUNNING, environmentId: plan.environmentId } });
    }
  }

  const planLogs: string[] = [];
  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    planLogs.push(`[${timestamp}] ${message}`);
  };

  log(`Starting deployment plan: ${plan.name}${plan.parallelExecution ? ' (parallel mode)' : ''}`);

  try {
    if (plan.parallelExecution) {
      const levelGroups = groupStepsByLevel(plan.steps);
      const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

      for (const level of sortedLevels) {
        const levelSteps = levelGroups.get(level)!;
        const validSteps = levelSteps.filter((step) => step.serviceDeployment);
        if (validSteps.length === 0) continue;

        log(`Executing level ${level}: ${validSteps.length} step(s) in parallel`);

        const results = await Promise.all(
          validSteps.map(async (step) => {
            await prisma.deploymentPlanStep.update({
              where: { id: step.id },
              data: { status: STEP_STATUS.RUNNING, startedAt: new Date() },
            });

            const svcName = step.serviceDeployment!.service.name;
            log(`  Starting ${step.action} ${svcName}`);

            if (step.action === 'deploy') {
              await executeDeployStep(step, plan, (msg) => log(`    [${svcName}] ${msg}`));
            } else if (step.action === 'health_check') {
              await executeHealthCheckStep(step, plan, (msg) => log(`    [${svcName}] ${msg}`));
            }

            return prisma.deploymentPlanStep.findUniqueOrThrow({
              where: { id: step.id },
              include: {
                service: true,
                serviceDeployment: { include: { server: true, service: true } },
              },
            });
          })
        );

        const failedStep = results.find((s) => s.status === STEP_STATUS.FAILED);
        if (failedStep) {
          const failedSvc = failedStep.serviceDeployment?.service ?? failedStep.service;
          if (plan.autoRollback) {
            log(`Level ${level} failed (${failedSvc?.name}), initiating rollback...`);
            await rollbackPlan(planId, log);
            return;
          } else {
            log(`Level ${level} failed (${failedSvc?.name}), auto-rollback disabled`);
            await prisma.deploymentPlan.update({
              where: { id: planId },
              data: {
                status: PLAN_STATUS.FAILED,
                completedAt: new Date(),
                error: failedStep.error,
                logs: planLogs.join('\n'),
              },
            });

            await sendSystemNotification(
              NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
              plan.environmentId,
              {
                planName: plan.name,
                serviceName: failedSvc?.name,
                serviceId: failedSvc?.id,
                serverName: failedStep.serviceDeployment?.server?.name,
                imageTag: failedStep.targetTag,
                error: failedStep.error,
              }
            );
            return;
          }
        }
      }
    } else {
      // Sequential execution: halt on first failure with rollback hint.
      for (const step of plan.steps) {
        if (!step.serviceDeployment) {
          log(`Skipping step ${step.order}: no service deployment associated`);
          continue;
        }

        await prisma.deploymentPlanStep.update({
          where: { id: step.id },
          data: { status: STEP_STATUS.RUNNING, startedAt: new Date() },
        });

        const svcName = step.serviceDeployment.service.name;
        log(`Executing step ${step.order}: ${step.action} ${svcName}`);

        if (step.action === 'deploy') {
          await executeDeployStep(step, plan, log);
        } else if (step.action === 'health_check') {
          await executeHealthCheckStep(step, plan, log);
        }

        const updatedStep = await prisma.deploymentPlanStep.findUniqueOrThrow({
          where: { id: step.id },
        });

        if (updatedStep.status === STEP_STATUS.FAILED) {
          if (plan.autoRollback) {
            log(`Step ${step.order} failed, initiating rollback (sequential strategy halts on first failure)...`);
            await rollbackPlan(planId, log);
            return;
          } else {
            log(`Step ${step.order} failed, sequential strategy halted; auto-rollback disabled (rollback hint: re-deploy previous tag manually)`);
            await prisma.deploymentPlan.update({
              where: { id: planId },
              data: {
                status: PLAN_STATUS.FAILED,
                completedAt: new Date(),
                error: updatedStep.error,
                logs: planLogs.join('\n'),
              },
            });

            await sendSystemNotification(
              NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
              plan.environmentId,
              {
                planName: plan.name,
                serviceName: svcName,
                serviceId: step.serviceDeployment.service.id,
                serverName: step.serviceDeployment.server?.name,
                imageTag: step.targetTag,
                error: updatedStep.error,
              }
            );
            return;
          }
        }
      }
    }

    log('Deployment plan completed successfully');

    await prisma.deploymentPlan.update({
      where: { id: planId },
      data: {
        status: PLAN_STATUS.COMPLETED,
        completedAt: new Date(),
        logs: planLogs.join('\n'),
      },
    });

    for (const step of plan.steps) {
      if (step.service && step.action === 'deploy') {
        eventBus.emitEvent({ type: 'deployment_progress', data: { planId, serviceId: step.service.id, status: PLAN_STATUS.COMPLETED, environmentId: plan.environmentId } });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);

    await prisma.deploymentPlan.update({
      where: { id: planId },
      data: {
        status: PLAN_STATUS.FAILED,
        completedAt: new Date(),
        error: errorMessage,
        logs: planLogs.join('\n'),
      },
    });

    for (const step of plan.steps) {
      if (step.service && step.action === 'deploy') {
        eventBus.emitEvent({ type: 'deployment_progress', data: { planId, serviceId: step.service.id, status: PLAN_STATUS.FAILED, environmentId: plan.environmentId } });
      }
    }

    if (plan.autoRollback) {
      await rollbackPlan(planId);
    }
  }
}

/**
 * Synchronous dry-run preview for a deployment plan. Iterates the same
 * ordered deploy steps that `executePlan` would run, calls the per-deployment
 * dry-run for each, and returns the collected report.
 *
 * Unlike `executePlan` this is synchronous (the caller awaits the report
 * before responding) and has no side effects: no plan-status transition, no
 * step rows updated, no audit events emitted from inside the service layer.
 */
export async function executePlanDryRun(planId: string): Promise<PlanDryRunReport> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        include: {
          service: true,
          serviceDeployment: { include: { server: true, service: true } },
        },
      },
    },
  });

  const steps: PlanDryRunReport['steps'] = [];
  for (const step of plan.steps) {
    if (step.action !== 'deploy' || !step.serviceDeployment) continue;
    // Pass `step.targetTag` through so the preview matches what the live
    // `executePlan` path would deploy (it passes `imageTag: step.targetTag`
    // to `deployService`). Without this, the dry-run would render the
    // service's CURRENT tag, not the planned target.
    const report = await deployServiceDryRun(step.serviceDeployment.id, {
      imageTag: step.targetTag ?? undefined,
    });
    steps.push({
      ...report,
      stepOrder: step.order,
      serviceName: step.serviceDeployment.service.name,
    });
  }

  return {
    dryRun: true,
    planId: plan.id,
    planName: plan.name,
    steps,
  };
}

async function executeDeployStep(
  step: StepWithDeployment,
  plan: DeploymentPlan,
  log: (msg: string) => void
): Promise<void> {
  if (!step.serviceDeployment || !step.targetTag) {
    throw new Error('Invalid deploy step: missing service deployment or target tag');
  }

  const svcName = step.serviceDeployment.service.name;

  try {
    const result = await deployService(
      step.serviceDeployment.id,
      plan.triggeredBy || 'deployment-plan',
      plan.userId,
      {
        imageTag: step.targetTag,
        generateArtifacts: true,
        pullImage: true,
      }
    );

    if (result.deployment.status === DEPLOYMENT_STATUS.SUCCESS) {
      log(`Deploy ${svcName}: success`);
      await prisma.deploymentPlanStep.update({
        where: { id: step.id },
        data: {
          status: STEP_STATUS.SUCCESS,
          completedAt: new Date(),
          deploymentId: result.deployment.id,
          logs: result.logs,
        },
      });
    } else {
      log(`Deploy ${svcName}: failed - ${result.logs}`);
      await prisma.deploymentPlanStep.update({
        where: { id: step.id },
        data: {
          status: STEP_STATUS.FAILED,
          completedAt: new Date(),
          deploymentId: result.deployment.id,
          error: 'Deployment failed',
          logs: result.logs,
        },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Deploy ${svcName}: error - ${errorMessage}`);
    await prisma.deploymentPlanStep.update({
      where: { id: step.id },
      data: {
        status: STEP_STATUS.FAILED,
        completedAt: new Date(),
        error: errorMessage,
      },
    });
  }
}

async function executeHealthCheckStep(
  step: StepWithDeployment,
  plan: DeploymentPlan,
  log: (msg: string) => void
): Promise<void> {
  if (!step.serviceDeployment) {
    throw new Error('Invalid health check step: missing service deployment');
  }

  const svcName = step.serviceDeployment.service.name;

  try {
    const result = await verifyServiceHealth({
      serviceDeploymentId: step.serviceDeployment.id,
    });

    if (result.healthy) {
      log(`Health check ${svcName}: healthy`);
      await prisma.deploymentPlanStep.update({
        where: { id: step.id },
        data: {
          status: STEP_STATUS.SUCCESS,
          completedAt: new Date(),
          healthPassed: true,
          healthDetails: JSON.stringify({
            containerStatus: result.containerStatus,
            healthStatus: result.healthStatus,
            urlCheck: result.urlCheck,
            attempts: result.attempts,
          }),
          logs: result.logs.join('\n'),
        },
      });
    } else {
      log(`Health check ${svcName}: unhealthy after ${result.attempts} attempts`);
      await prisma.deploymentPlanStep.update({
        where: { id: step.id },
        data: {
          status: STEP_STATUS.FAILED,
          completedAt: new Date(),
          healthPassed: false,
          healthDetails: JSON.stringify({
            containerStatus: result.containerStatus,
            healthStatus: result.healthStatus,
            urlCheck: result.urlCheck,
            attempts: result.attempts,
          }),
          error: `Health check failed after ${result.attempts} attempts`,
          logs: result.logs.join('\n'),
        },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Health check ${svcName}: error - ${errorMessage}`);
    await prisma.deploymentPlanStep.update({
      where: { id: step.id },
      data: {
        status: STEP_STATUS.FAILED,
        completedAt: new Date(),
        healthPassed: false,
        error: errorMessage,
      },
    });
  }
}

/**
 * Rollback all deployments in a failed plan back to their previousTag.
 */
export async function rollbackPlan(
  planId: string,
  existingLog?: (msg: string) => void
): Promise<void> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'desc' },
        include: {
          service: true,
          serviceDeployment: { include: { server: true, service: true } },
        },
      },
    },
  });

  const rollbackLogs: string[] = [];
  const log = existingLog || ((message: string) => {
    const timestamp = new Date().toISOString();
    rollbackLogs.push(`[${timestamp}] ${message}`);
  });

  log('Starting rollback...');

  const stepsToRollback = plan.steps.filter(
    (step) =>
      step.action === 'deploy' &&
      step.serviceDeployment &&
      (step.status === STEP_STATUS.SUCCESS || step.status === STEP_STATUS.RUNNING) &&
      step.previousTag
  );

  for (const step of stepsToRollback) {
    if (!step.serviceDeployment || !step.previousTag) continue;

    const svcName = step.serviceDeployment.service.name;
    log(`Rolling back ${svcName} to ${step.previousTag}`);

    try {
      const result = await deployService(
        step.serviceDeployment.id,
        'rollback',
        plan.userId,
        {
          imageTag: step.previousTag,
          generateArtifacts: true,
          pullImage: true,
        }
      );

      if (result.deployment.status === DEPLOYMENT_STATUS.SUCCESS) {
        log(`Rollback ${svcName}: success`);
        await prisma.deploymentPlanStep.update({
          where: { id: step.id },
          data: { status: STEP_STATUS.ROLLED_BACK },
        });
      } else {
        log(`Rollback ${svcName}: failed`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Rollback ${svcName}: error - ${errorMessage}`);
    }
  }

  log('Rollback completed');

  const currentPlan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
  });

  const allLogs = currentPlan.logs
    ? `${currentPlan.logs}\n${rollbackLogs.join('\n')}`
    : rollbackLogs.join('\n');

  await prisma.deploymentPlan.update({
    where: { id: planId },
    data: {
      status: PLAN_STATUS.ROLLED_BACK,
      completedAt: new Date(),
      logs: allLogs,
    },
  });

  const failedStep = plan.steps.find((s) => s.status === STEP_STATUS.FAILED);
  const failedSvc = failedStep?.serviceDeployment?.service ?? failedStep?.service;

  await sendSystemNotification(
    NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
    plan.environmentId,
    {
      planName: plan.name,
      serviceName: failedSvc?.name,
      serviceId: failedSvc?.id,
      serverName: failedStep?.serviceDeployment?.server?.name,
      imageTag: failedStep?.targetTag,
      error: 'Deployment rolled back due to failure',
      rollback: true,
    }
  );
}

export async function cancelPlan(planId: string): Promise<void> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
  });

  if (plan.status !== PLAN_STATUS.PENDING && plan.status !== PLAN_STATUS.RUNNING) {
    throw new Error(`Cannot cancel plan with status: ${plan.status}`);
  }

  await prisma.deploymentPlanStep.updateMany({
    where: {
      deploymentPlanId: planId,
      status: STEP_STATUS.PENDING,
    },
    data: { status: STEP_STATUS.SKIPPED },
  });

  await prisma.deploymentPlan.update({
    where: { id: planId },
    data: {
      status: PLAN_STATUS.CANCELLED,
      completedAt: new Date(),
    },
  });
}

export async function getDeploymentPlan(planId: string) {
  return prisma.deploymentPlan.findUnique({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        include: {
          service: true,
          serviceDeployment: {
            include: {
              server: { select: { name: true } },
              service: { select: { id: true, name: true } },
            },
          },
          deployment: true,
        },
      },
      containerImage: true,
      user: { select: { id: true, email: true, name: true } },
      environment: { select: { id: true, name: true } },
    },
  });
}

export async function listDeploymentPlans(
  environmentId: string,
  limit: number = 50
) {
  return prisma.deploymentPlan.findMany({
    where: { environmentId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          order: true,
          status: true,
          action: true,
          service: { select: { id: true, name: true } },
          serviceDeployment: { select: { id: true, server: { select: { name: true } } } },
        },
      },
      containerImage: { select: { id: true, name: true } },
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
