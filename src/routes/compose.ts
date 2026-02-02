import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  generateDeploymentArtifacts,
  previewDeploymentArtifacts,
  getDeploymentArtifacts,
} from '../services/compose.js';

const composeTemplateSchema = z.object({
  composeTemplate: z.string().min(1),
});

export async function composeRoutes(fastify: FastifyInstance): Promise<void> {
  // Preview generated artifacts for a service (without deploying)
  fastify.get(
    '/api/services/:id/compose/preview',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const artifacts = await previewDeploymentArtifacts(id);
        return { artifacts };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Generation failed';
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Get/set compose template for a service
  fastify.get(
    '/api/services/:id/compose/template',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        select: { id: true, name: true, composeTemplate: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      return { template: service.composeTemplate };
    }
  );

  fastify.put(
    '/api/services/:id/compose/template',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = composeTemplateSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const service = await prisma.service.update({
          where: { id },
          data: { composeTemplate: body.data.composeTemplate },
          select: { id: true, name: true, composeTemplate: true },
        });

        return { template: service.composeTemplate };
      } catch {
        return reply.code(404).send({ error: 'Service not found' });
      }
    }
  );

  // Delete compose template (revert to auto-generated)
  fastify.delete(
    '/api/services/:id/compose/template',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        await prisma.service.update({
          where: { id },
          data: { composeTemplate: null },
        });

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Service not found' });
      }
    }
  );

  // Get artifacts from a specific deployment
  fastify.get(
    '/api/deployments/:id/artifacts',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const deployment = await prisma.deployment.findUnique({
        where: { id },
      });

      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const artifacts = await getDeploymentArtifacts(id);
      return { artifacts };
    }
  );

  // Download a specific artifact
  fastify.get(
    '/api/artifacts/:id/download',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const artifact = await prisma.deploymentArtifact.findUnique({
        where: { id },
      });

      if (!artifact) {
        return reply.code(404).send({ error: 'Artifact not found' });
      }

      reply.header('Content-Type', 'text/plain');
      reply.header('Content-Disposition', `attachment; filename="${artifact.name}"`);
      return artifact.content;
    }
  );
}
