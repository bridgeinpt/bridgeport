import { prisma } from '../lib/db.js';
import { deployService, type DeployResult } from './deploy.js';
import { verifyServiceHealth, type HealthVerificationResult } from './health-verification.js';
import { recordTagDeployment } from './image-management.js';
import { sendSystemNotification, NOTIFICATION_TYPES } from './notifications.js';
import { eventBus } from '../lib/event-bus.js';
import { DEPLOYMENT_STATUS, PLAN_STATUS, STEP_STATUS } from '../lib/constants.js';
import type { DeploymentPlan, DeploymentPlanStep, Server, Service, ServiceDependency } from '@prisma/client';

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
  server: { name: string; hostname: string };
};

/**
 * Detect cycles in the dependency graph using DFS
 */
function detectCycle(
  services: Map<string, ServiceWithDeps>,
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
export function resolveDependencyOrder(services: ServiceWithDeps[]): ServiceWithDeps[][] {
  if (services.length === 0) return [];

  // Build adjacency list and in-degree map
  const serviceMap = new Map<string, ServiceWithDeps>();
  const inDegree = new Map<string, number>();
  const adjacencyList = new Map<string, string[]>();

  for (const service of services) {
    serviceMap.set(service.id, service);
    inDegree.set(service.id, 0);
    adjacencyList.set(service.id, []);
  }

  // Count incoming edges (dependencies)
  for (const service of services) {
    for (const dep of service.dependencies) {
      // Only consider dependencies that are part of this deployment
      if (serviceMap.has(dep.dependsOnId)) {
        inDegree.set(service.id, (inDegree.get(service.id) || 0) + 1);
        const adj = adjacencyList.get(dep.dependsOnId) || [];
        adj.push(service.id);
        adjacencyList.set(dep.dependsOnId, adj);
      }
    }
  }

  // Detect cycles
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

  // Kahn's algorithm with level tracking
  const levels: ServiceWithDeps[][] = [];
  let queue = services.filter((s) => inDegree.get(s.id) === 0);

  while (queue.length > 0) {
    levels.push(queue);
    const nextQueue: ServiceWithDeps[] = [];

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

  // Check if all services were processed (should be, since we already checked for cycles)
  const processedCount = levels.reduce((sum, level) => sum + level.length, 0);
  if (processedCount !== services.length) {
    throw new Error('Dependency resolution failed: not all services could be ordered');
  }

  return levels;
}

/**
 * Build a deployment plan from the given options
 */
export async function buildDeploymentPlan(options: BuildPlanOptions): Promise<DeploymentPlan> {
  let services: ServiceWithDeps[];

  if (options.containerImageId) {
    // Get all services linked to this container image
    services = await prisma.service.findMany({
      where: { containerImageId: options.containerImageId },
      include: {
        server: { select: { name: true, hostname: true } },
        dependencies: { include: { dependsOn: true } },
        dependents: { include: { dependent: true } },
      },
    });
  } else if (options.serviceIds && options.serviceIds.length > 0) {
    // Get specified services
    services = await prisma.service.findMany({
      where: { id: { in: options.serviceIds } },
      include: {
        server: { select: { name: true, hostname: true } },
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

  // Resolve deployment order
  const orderedLevels = resolveDependencyOrder(services);

  // Generate plan name
  const serviceNames = services.map((s) => s.name).slice(0, 3);
  const planName = options.containerImageId
    ? `Deploy ${options.imageTag}`
    : `Deploy ${serviceNames.join(', ')}${services.length > 3 ? '...' : ''}`;

  // Create the deployment plan
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

  // Build all steps then batch-insert them
  let stepOrder = 0;
  const stepsToCreate: {
    deploymentPlanId: string;
    serviceId: string;
    order: number;
    action: string;
    targetTag: string;
    previousTag: string | null;
  }[] = [];

  for (const level of orderedLevels) {
    for (const service of level) {
      // Check if this service has health_before dependencies
      const hasHealthDependency = service.dependencies.some((d) => d.type === 'health_before');

      // Add deploy step
      stepsToCreate.push({
        deploymentPlanId: plan.id,
        serviceId: service.id,
        order: stepOrder++,
        action: 'deploy',
        targetTag: options.imageTag,
        previousTag: service.imageTag,
      });

      // Add health check step if needed
      if (hasHealthDependency || service.healthCheckUrl) {
        stepsToCreate.push({
          deploymentPlanId: plan.id,
          serviceId: service.id,
          order: stepOrder++,
          action: 'health_check',
          targetTag: options.imageTag,
          previousTag: service.imageTag,
        });
      }
    }
  }

  await prisma.deploymentPlanStep.createMany({ data: stepsToCreate });

  return prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: plan.id },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
}

/**
 * Group steps by their order (dependency level) for parallel execution
 */
function groupStepsByLevel(
  steps: (DeploymentPlanStep & { service: (Service & { server: Server }) | null })[]
): Map<number, (DeploymentPlanStep & { service: (Service & { server: Server }) | null })[]> {
  const levels = new Map<number, (DeploymentPlanStep & { service: (Service & { server: Server }) | null })[]>();

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
        include: { service: { include: { server: true } } },
      },
      containerImage: true,
      environment: true,
    },
  });

  if (plan.status !== PLAN_STATUS.PENDING) {
    throw new Error(`Plan is already ${plan.status}`);
  }

  // Mark plan as running
  await prisma.deploymentPlan.update({
    where: { id: planId },
    data: { status: PLAN_STATUS.RUNNING, startedAt: new Date() },
  });

  // Emit progress events for all services in the plan
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
      // Parallel execution: group steps by level and run each level in parallel
      const levelGroups = groupStepsByLevel(plan.steps);
      const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

      for (const level of sortedLevels) {
        const levelSteps = levelGroups.get(level)!;

        // Filter out steps without services
        const validSteps = levelSteps.filter((step) => step.service);
        if (validSteps.length === 0) continue;

        log(`Executing level ${level}: ${validSteps.length} step(s) in parallel`);

        // Execute all steps in this level in parallel
        const results = await Promise.all(
          validSteps.map(async (step) => {
            // Mark step as running
            await prisma.deploymentPlanStep.update({
              where: { id: step.id },
              data: { status: STEP_STATUS.RUNNING, startedAt: new Date() },
            });

            log(`  Starting ${step.action} ${step.service!.name}`);

            if (step.action === 'deploy') {
              await executeDeployStep(step, plan, (msg) => log(`    [${step.service!.name}] ${msg}`));
            } else if (step.action === 'health_check') {
              await executeHealthCheckStep(step, plan, (msg) => log(`    [${step.service!.name}] ${msg}`));
            }

            // Return the step result
            return prisma.deploymentPlanStep.findUniqueOrThrow({
              where: { id: step.id },
              include: { service: { include: { server: true } } },
            });
          })
        );

        // Check if any step in this level failed
        const failedStep = results.find((s) => s.status === STEP_STATUS.FAILED);
        if (failedStep) {
          if (plan.autoRollback) {
            log(`Level ${level} failed (${failedStep.service?.name}), initiating rollback...`);
            await rollbackPlan(planId, log);
            return;
          } else {
            log(`Level ${level} failed (${failedStep.service?.name}), auto-rollback disabled`);
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
                serviceName: failedStep.service?.name,
                serviceId: failedStep.service?.id,
                serverName: failedStep.service?.server?.name,
                imageTag: failedStep.targetTag,
                error: failedStep.error,
              }
            );
            return;
          }
        }
      }
    } else {
      // Sequential execution (original behavior)
      for (const step of plan.steps) {
        if (!step.service) {
          log(`Skipping step ${step.order}: no service associated`);
          continue;
        }

        // Mark step as running
        await prisma.deploymentPlanStep.update({
          where: { id: step.id },
          data: { status: STEP_STATUS.RUNNING, startedAt: new Date() },
        });

        log(`Executing step ${step.order}: ${step.action} ${step.service.name}`);

        if (step.action === 'deploy') {
          await executeDeployStep(step, plan, log);
        } else if (step.action === 'health_check') {
          await executeHealthCheckStep(step, plan, log);
        }

        // Check if step failed and we need to rollback
        const updatedStep = await prisma.deploymentPlanStep.findUniqueOrThrow({
          where: { id: step.id },
        });

        if (updatedStep.status === STEP_STATUS.FAILED) {
          if (plan.autoRollback) {
            log(`Step ${step.order} failed, initiating rollback...`);
            await rollbackPlan(planId, log);
            return;
          } else {
            log(`Step ${step.order} failed, auto-rollback disabled`);
            await prisma.deploymentPlan.update({
              where: { id: planId },
              data: {
                status: PLAN_STATUS.FAILED,
                completedAt: new Date(),
                error: updatedStep.error,
                logs: planLogs.join('\n'),
              },
            });

            // Send failure notification
            await sendSystemNotification(
              NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
              plan.environmentId,
              {
                planName: plan.name,
                serviceName: step.service.name,
                serviceId: step.service.id,
                serverName: step.service.server?.name,
                imageTag: step.targetTag,
                error: updatedStep.error,
              }
            );
            return;
          }
        }
      }
    }

    // All steps completed successfully
    log('Deployment plan completed successfully');

    // Note: Individual deployService calls now record history entries,
    // so we don't need to record here for containerImage

    await prisma.deploymentPlan.update({
      where: { id: planId },
      data: {
        status: PLAN_STATUS.COMPLETED,
        completedAt: new Date(),
        logs: planLogs.join('\n'),
      },
    });

    // Emit completion events for all deploy steps
    for (const step of plan.steps) {
      if (step.service && step.action === 'deploy') {
        eventBus.emitEvent({ type: 'deployment_progress', data: { planId, serviceId: step.service.id, status: PLAN_STATUS.COMPLETED, environmentId: plan.environmentId } });
      }
    }

    // Note: per-service success notifications are already sent by deploy.ts
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

    // Emit failure events for all deploy steps
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

async function executeDeployStep(
  step: DeploymentPlanStep & { service: (Service & { server: Server }) | null },
  plan: DeploymentPlan,
  log: (msg: string) => void
): Promise<void> {
  if (!step.service || !step.targetTag) {
    throw new Error('Invalid deploy step: missing service or target tag');
  }

  try {
    const result = await deployService(
      step.service.id,
      plan.triggeredBy || 'deployment-plan',
      plan.userId,
      {
        imageTag: step.targetTag,
        generateArtifacts: true,
        pullImage: true,
      }
    );

    if (result.deployment.status === DEPLOYMENT_STATUS.SUCCESS) {
      log(`Deploy ${step.service.name}: success`);
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
      log(`Deploy ${step.service.name}: failed - ${result.logs}`);
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
    log(`Deploy ${step.service.name}: error - ${errorMessage}`);
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
  step: DeploymentPlanStep & { service: (Service & { server: Server }) | null },
  plan: DeploymentPlan,
  log: (msg: string) => void
): Promise<void> {
  if (!step.service) {
    throw new Error('Invalid health check step: missing service');
  }

  try {
    const result = await verifyServiceHealth({
      serviceId: step.service.id,
    });

    if (result.healthy) {
      log(`Health check ${step.service.name}: healthy`);
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
      log(`Health check ${step.service.name}: unhealthy after ${result.attempts} attempts`);
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
    log(`Health check ${step.service.name}: error - ${errorMessage}`);
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
 * Rollback all services in a failed deployment plan
 */
export async function rollbackPlan(
  planId: string,
  existingLog?: (msg: string) => void
): Promise<void> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'desc' }, // Reverse order for rollback
        include: { service: true },
      },
    },
  });

  const rollbackLogs: string[] = [];
  const log = existingLog || ((message: string) => {
    const timestamp = new Date().toISOString();
    rollbackLogs.push(`[${timestamp}] ${message}`);
  });

  log('Starting rollback...');

  // Find all deploy steps that succeeded and need rollback
  const stepsToRollback = plan.steps.filter(
    (step) =>
      step.action === 'deploy' &&
      (step.status === STEP_STATUS.SUCCESS || step.status === STEP_STATUS.RUNNING) &&
      step.previousTag
  );

  for (const step of stepsToRollback) {
    if (!step.service || !step.previousTag) continue;

    log(`Rolling back ${step.service.name} to ${step.previousTag}`);

    try {
      const result = await deployService(
        step.service.id,
        'rollback',
        plan.userId,
        {
          imageTag: step.previousTag,
          generateArtifacts: true,
          pullImage: true,
        }
      );

      if (result.deployment.status === DEPLOYMENT_STATUS.SUCCESS) {
        log(`Rollback ${step.service.name}: success`);
        await prisma.deploymentPlanStep.update({
          where: { id: step.id },
          data: { status: STEP_STATUS.ROLLED_BACK },
        });
      } else {
        log(`Rollback ${step.service.name}: failed`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Rollback ${step.service.name}: error - ${errorMessage}`);
    }
  }

  log('Rollback completed');

  // Get current logs and append rollback logs
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

  // Send rollback notification
  await sendSystemNotification(
    NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED,
    plan.environmentId,
    {
      planName: plan.name,
      error: 'Deployment rolled back due to failure',
      rollback: true,
    }
  );
}

/**
 * Cancel a pending or running deployment plan
 */
export async function cancelPlan(planId: string): Promise<void> {
  const plan = await prisma.deploymentPlan.findUniqueOrThrow({
    where: { id: planId },
  });

  if (plan.status !== PLAN_STATUS.PENDING && plan.status !== PLAN_STATUS.RUNNING) {
    throw new Error(`Cannot cancel plan with status: ${plan.status}`);
  }

  // Mark all pending steps as skipped
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

/**
 * Get deployment plan with all details
 */
export async function getDeploymentPlan(planId: string) {
  return prisma.deploymentPlan.findUnique({
    where: { id: planId },
    include: {
      steps: {
        orderBy: { order: 'asc' },
        include: {
          service: {
            include: {
              server: { select: { name: true } },
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

/**
 * List deployment plans for an environment
 */
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
        },
      },
      containerImage: { select: { id: true, name: true } },
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
