import { prisma } from '../lib/db.js';
import type { DeploymentTemplate, Service } from '@prisma/client';
import { resolveDependencyOrder, type BuildPlanOptions, buildDeploymentPlan, executePlan } from './orchestration.js';

// Template Definition Types
export interface TemplateDefinition {
  version: '1.0';
  parallelExecution: boolean;
  steps: TemplateStep[];
}

export interface TemplateStep {
  type: 'deploy' | 'health_check' | 'wait' | 'group';

  // For deploy steps
  serviceSelector?: {
    by: 'id' | 'name' | 'tag' | 'serviceType';
    value: string;
    pattern?: boolean; // Treat value as glob pattern
  };

  // For health_check steps
  waitMs?: number;
  retries?: number;

  // For wait steps
  durationMs?: number;

  // For group steps (explicit parallel group)
  name?: string;
  parallel?: boolean;
  children?: TemplateStep[];
}

// Preview Types
export interface PlanPreview {
  levels: PreviewLevel[];
  estimatedDurationMs: number;
  servicesCount: number;
  warnings: string[];
}

export interface PreviewLevel {
  order: number;
  parallel: boolean;
  steps: PreviewStep[];
}

export interface PreviewStep {
  type: 'deploy' | 'health_check' | 'wait';
  serviceName?: string;
  serviceId?: string;
  serverName?: string;
  currentTag?: string;
  targetTag?: string;
  healthCheckUrl?: string;
  estimatedDurationMs?: number;
  waitMs?: number;
}

type ServiceWithServer = Service & {
  server: { id: string; name: string };
  serviceType: { id: string; name: string } | null;
};

/**
 * Parse and validate a template definition JSON string
 */
export function parseTemplateDefinition(json: string): TemplateDefinition {
  const parsed = JSON.parse(json);

  if (parsed.version !== '1.0') {
    throw new Error(`Unsupported template version: ${parsed.version}`);
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error('Template must have a steps array');
  }

  return parsed as TemplateDefinition;
}

/**
 * Match services against a service selector
 */
async function matchServices(
  environmentId: string,
  selector: TemplateStep['serviceSelector']
): Promise<ServiceWithServer[]> {
  if (!selector) return [];

  let where: Record<string, unknown> = {
    server: { environmentId },
    discoveryStatus: 'found',
  };

  switch (selector.by) {
    case 'id':
      where.id = selector.value;
      break;
    case 'name':
      if (selector.pattern) {
        // Convert glob pattern to SQL LIKE pattern
        const likePattern = selector.value.replace(/\*/g, '%').replace(/\?/g, '_');
        where.name = { contains: likePattern.replace(/%/g, '') };
      } else {
        where.name = selector.value;
      }
      break;
    case 'tag':
      where.server = {
        environmentId,
        tags: { contains: `"${selector.value}"` },
      };
      break;
    case 'serviceType':
      where.serviceType = { name: selector.value };
      break;
  }

  return prisma.service.findMany({
    where,
    include: {
      server: { select: { id: true, name: true } },
      serviceType: { select: { id: true, name: true } },
    },
  });
}

/**
 * Build a preview of the execution plan from a template
 */
export async function buildTemplatePreview(
  templateId: string,
  targetTag: string
): Promise<PlanPreview> {
  const template = await prisma.deploymentTemplate.findUniqueOrThrow({
    where: { id: templateId },
  });

  const definition = parseTemplateDefinition(template.definition);
  const warnings: string[] = [];
  const levels: PreviewLevel[] = [];
  let totalEstimatedMs = 0;
  const allServices = new Set<string>();

  let currentOrder = 0;

  for (const step of definition.steps) {
    if (step.type === 'group' && step.children) {
      const groupSteps: PreviewStep[] = [];

      for (const child of step.children) {
        const childSteps = await resolveStepPreview(
          template.environmentId,
          child,
          targetTag,
          warnings,
          allServices
        );
        groupSteps.push(...childSteps);
      }

      if (groupSteps.length > 0) {
        const levelDuration = step.parallel
          ? Math.max(...groupSteps.map((s) => s.estimatedDurationMs || 0))
          : groupSteps.reduce((sum, s) => sum + (s.estimatedDurationMs || 0), 0);

        levels.push({
          order: currentOrder++,
          parallel: step.parallel ?? false,
          steps: groupSteps,
        });
        totalEstimatedMs += levelDuration;
      }
    } else if (step.type === 'wait') {
      levels.push({
        order: currentOrder++,
        parallel: false,
        steps: [{
          type: 'wait',
          waitMs: step.durationMs,
          estimatedDurationMs: step.durationMs,
        }],
      });
      totalEstimatedMs += step.durationMs || 0;
    } else {
      const stepPreviews = await resolveStepPreview(
        template.environmentId,
        step,
        targetTag,
        warnings,
        allServices
      );

      if (stepPreviews.length > 0) {
        const levelDuration = definition.parallelExecution
          ? Math.max(...stepPreviews.map((s) => s.estimatedDurationMs || 0))
          : stepPreviews.reduce((sum, s) => sum + (s.estimatedDurationMs || 0), 0);

        levels.push({
          order: currentOrder++,
          parallel: definition.parallelExecution,
          steps: stepPreviews,
        });
        totalEstimatedMs += levelDuration;
      }
    }
  }

  return {
    levels,
    estimatedDurationMs: totalEstimatedMs,
    servicesCount: allServices.size,
    warnings,
  };
}

async function resolveStepPreview(
  environmentId: string,
  step: TemplateStep,
  targetTag: string,
  warnings: string[],
  allServices: Set<string>
): Promise<PreviewStep[]> {
  if (step.type === 'deploy' && step.serviceSelector) {
    const services = await matchServices(environmentId, step.serviceSelector);

    if (services.length === 0) {
      warnings.push(`No services matched selector: ${JSON.stringify(step.serviceSelector)}`);
      return [];
    }

    return services.map((service) => {
      allServices.add(service.id);
      return {
        type: 'deploy' as const,
        serviceId: service.id,
        serviceName: service.name,
        serverName: service.server.name,
        currentTag: service.imageTag,
        targetTag,
        estimatedDurationMs: 30000, // Default estimate
      };
    });
  }

  if (step.type === 'health_check' && step.serviceSelector) {
    const services = await matchServices(environmentId, step.serviceSelector);

    return services.map((service) => {
      if (!service.healthCheckUrl) {
        warnings.push(`Service ${service.name} has no health check URL configured`);
      }
      return {
        type: 'health_check' as const,
        serviceId: service.id,
        serviceName: service.name,
        serverName: service.server.name,
        healthCheckUrl: service.healthCheckUrl || undefined,
        estimatedDurationMs: (step.waitMs || 30000) + ((step.retries || 3) * 5000),
      };
    });
  }

  if (step.type === 'wait') {
    return [{
      type: 'wait' as const,
      waitMs: step.durationMs,
      estimatedDurationMs: step.durationMs,
    }];
  }

  return [];
}

/**
 * Execute a deployment template
 */
export async function executeTemplate(
  templateId: string,
  targetTag: string,
  triggeredBy: string,
  userId: string
): Promise<{ planId: string }> {
  const template = await prisma.deploymentTemplate.findUniqueOrThrow({
    where: { id: templateId },
  });

  const definition = parseTemplateDefinition(template.definition);

  // Collect all services from the template
  const serviceIds: string[] = [];
  for (const step of definition.steps) {
    if (step.type === 'group' && step.children) {
      for (const child of step.children) {
        if (child.type === 'deploy' && child.serviceSelector) {
          const services = await matchServices(template.environmentId, child.serviceSelector);
          serviceIds.push(...services.map((s) => s.id));
        }
      }
    } else if (step.type === 'deploy' && step.serviceSelector) {
      const services = await matchServices(template.environmentId, step.serviceSelector);
      serviceIds.push(...services.map((s) => s.id));
    }
  }

  if (serviceIds.length === 0) {
    throw new Error('No services matched the template selectors');
  }

  // Build and execute the deployment plan
  const plan = await buildDeploymentPlan({
    environmentId: template.environmentId,
    serviceIds: [...new Set(serviceIds)], // Deduplicate
    imageTag: targetTag,
    triggerType: 'manual',
    triggeredBy,
    userId,
    parallelExecution: definition.parallelExecution,
    templateId: template.id,
  });

  // Update template usage stats
  await prisma.deploymentTemplate.update({
    where: { id: templateId },
    data: {
      lastUsedAt: new Date(),
      useCount: { increment: 1 },
    },
  });

  // Execute asynchronously
  executePlan(plan.id).catch((err) => {
    console.error(`[Template] Plan ${plan.id} execution failed:`, err);
  });

  return { planId: plan.id };
}
