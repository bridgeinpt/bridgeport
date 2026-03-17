import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  buildDeploymentPlan,
  executePlan,
  cancelPlan,
  rollbackPlan,
  getDeploymentPlan,
  listDeploymentPlans,
} from '../services/orchestration.js';
import { logAudit } from '../services/audit.js';
import { PLAN_STATUS, STEP_STATUS } from '../lib/constants.js';
import { validateBody, findOrNotFound, getErrorMessage } from '../lib/helpers.js';

const createPlanSchema = z.object({
  serviceIds: z.array(z.string()).min(1),
  imageTag: z.string().min(1),
  autoRollback: z.boolean().default(true),
});

export async function deploymentPlanRoutes(fastify: FastifyInstance): Promise<void> {
  // List deployment plans for environment
  fastify.get(
    '/api/environments/:envId/deployment-plans',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit } = request.query as { limit?: string };

      const plans = await listDeploymentPlans(envId, limit ? parseInt(limit) : 50);
      return { plans };
    }
  );

  // Create and optionally execute a deployment plan
  fastify.post(
    '/api/environments/:envId/deployment-plans',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const { execute } = request.query as { execute?: string };
      const body = validateBody(createPlanSchema, request, reply);
      if (!body) return;

      try {
        const plan = await buildDeploymentPlan({
          environmentId: envId,
          serviceIds: body.serviceIds,
          imageTag: body.imageTag,
          triggerType: 'manual',
          triggeredBy: request.authUser!.email,
          userId: request.authUser!.id,
          autoRollback: body.autoRollback,
        });

        await logAudit({
          action: 'create',
          resourceType: 'deployment_plan',
          resourceId: plan.id,
          resourceName: plan.name,
          details: {
            imageTag: body.imageTag,
            serviceCount: body.serviceIds.length,
            autoRollback: body.autoRollback,
          },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        // Execute immediately if requested
        if (execute === 'true') {
          executePlan(plan.id).catch((err) => {
            console.error(`[DeploymentPlan] Plan ${plan.id} execution failed:`, err);
          });
        }

        const fullPlan = await getDeploymentPlan(plan.id);
        return { plan: fullPlan };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to create deployment plan');
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Get deployment plan
  fastify.get(
    '/api/deployment-plans/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const plan = await findOrNotFound(getDeploymentPlan(id), 'Deployment plan', reply);
      if (!plan) return;

      return { plan };
    }
  );

  // Execute a pending deployment plan
  fastify.post(
    '/api/deployment-plans/:id/execute',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const plan = await findOrNotFound(prisma.deploymentPlan.findUnique({ where: { id } }), 'Deployment plan', reply);
      if (!plan) return;

      if (plan.status !== PLAN_STATUS.PENDING) {
        return reply.code(400).send({ error: `Cannot execute plan with status: ${plan.status}` });
      }

      await logAudit({
        action: 'deploy',
        resourceType: 'deployment_plan',
        resourceId: id,
        resourceName: plan.name,
        details: { action: 'execute' },
        userId: request.authUser!.id,
        environmentId: plan.environmentId,
      });

      // Execute asynchronously
      executePlan(id).catch((err) => {
        console.error(`[DeploymentPlan] Plan ${id} execution failed:`, err);
      });

      return { success: true, message: 'Plan execution started' };
    }
  );

  // Cancel a pending or running deployment plan
  fastify.post(
    '/api/deployment-plans/:id/cancel',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const plan = await findOrNotFound(prisma.deploymentPlan.findUnique({ where: { id } }), 'Deployment plan', reply);
      if (!plan) return;

      try {
        await cancelPlan(id);

        await logAudit({
          action: 'update',
          resourceType: 'deployment_plan',
          resourceId: id,
          resourceName: plan.name,
          details: { action: 'cancel' },
          userId: request.authUser!.id,
          environmentId: plan.environmentId,
        });

        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to cancel plan');
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Manually trigger rollback for a deployment plan
  fastify.post(
    '/api/deployment-plans/:id/rollback',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const plan = await findOrNotFound(
        prisma.deploymentPlan.findUnique({
          where: { id },
          include: { steps: true },
        }),
        'Deployment plan',
        reply
      );
      if (!plan) return;

      // Can only rollback completed or failed plans
      if (!([PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED] as string[]).includes(plan.status)) {
        return reply.code(400).send({
          error: `Cannot rollback plan with status: ${plan.status}`,
        });
      }

      // Check if any steps have been deployed
      const deployedSteps = plan.steps.filter(
        (s) => s.action === 'deploy' && (s.status === STEP_STATUS.SUCCESS || s.status === STEP_STATUS.ROLLED_BACK)
      );

      if (deployedSteps.length === 0) {
        return reply.code(400).send({ error: 'No deployed services to rollback' });
      }

      await logAudit({
        action: 'update',
        resourceType: 'deployment_plan',
        resourceId: id,
        resourceName: plan.name,
        details: { action: 'rollback', stepsToRollback: deployedSteps.length },
        userId: request.authUser!.id,
        environmentId: plan.environmentId,
      });

      // Execute rollback asynchronously
      rollbackPlan(id).catch((err) => {
        console.error(`[DeploymentPlan] Plan ${id} rollback failed:`, err);
      });

      return { success: true, message: 'Rollback started' };
    }
  );

  // Stream deployment plan updates (SSE)
  fastify.get(
    '/api/deployment-plans/:id/stream',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const plan = await findOrNotFound(prisma.deploymentPlan.findUnique({ where: { id } }), 'Deployment plan', reply);
      if (!plan) return;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial state
      const fullPlan = await getDeploymentPlan(id);
      reply.raw.write(`event: plan\n`);
      reply.raw.write(`data: ${JSON.stringify(fullPlan)}\n\n`);

      // Poll for updates
      let lastStatus = plan.status;
      let lastStepStatuses = new Map<string, string>();

      if (fullPlan) {
        for (const step of fullPlan.steps) {
          lastStepStatuses.set(step.id, step.status);
        }
      }

      const interval = setInterval(async () => {
        try {
          const currentPlan = await getDeploymentPlan(id);
          if (!currentPlan) {
            clearInterval(interval);
            reply.raw.end();
            return;
          }

          // Check for plan status changes
          if (currentPlan.status !== lastStatus) {
            lastStatus = currentPlan.status;
            reply.raw.write(`event: plan\n`);
            reply.raw.write(`data: ${JSON.stringify(currentPlan)}\n\n`);

            // If plan is done, stop streaming
            if (([PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED, PLAN_STATUS.ROLLED_BACK] as string[]).includes(currentPlan.status)) {
              clearInterval(interval);
              reply.raw.write(`event: done\n`);
              reply.raw.write(`data: ${JSON.stringify({ status: currentPlan.status })}\n\n`);
              reply.raw.end();
              return;
            }
          }

          // Check for step status changes
          for (const step of currentPlan.steps) {
            const previousStatus = lastStepStatuses.get(step.id);
            if (step.status !== previousStatus) {
              lastStepStatuses.set(step.id, step.status);
              reply.raw.write(`event: step\n`);
              reply.raw.write(`data: ${JSON.stringify(step)}\n\n`);
            }
          }
        } catch (error) {
          console.error('[DeploymentPlan] Stream error:', error);
          clearInterval(interval);
          reply.raw.write(`event: error\n`);
          reply.raw.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
          reply.raw.end();
        }
      }, 1000);

      // Cleanup on client disconnect
      request.raw.on('close', () => {
        clearInterval(interval);
      });
    }
  );
}
