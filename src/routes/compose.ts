import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  generateDeploymentArtifacts,
  previewDeploymentArtifacts,
  getDeploymentArtifacts,
} from '../services/compose.js';
import { validateBody, findOrNotFound, getErrorMessage } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

const idParamSchema = z.object({ id: z.string() });

const composeTemplateSchema = z.object({
  composeTemplate: z.string().min(1),
});

export async function composeRoutes(fastify: FastifyInstance): Promise<void> {
  // Preview generated artifacts for a service (without deploying)
  fastify.get(
    '/api/services/:id/compose/preview',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Preview the generated deployment artifacts for a service',
        params: idParamSchema,
        errors: [400, 401],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const artifacts = await previewDeploymentArtifacts(id);
        return { artifacts };
      } catch (error) {
        const message = getErrorMessage(error, 'Generation failed');
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Get/set compose template for a service
  fastify.get(
    '/api/services/:id/compose/template',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get the compose template for a service',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          select: { id: true, name: true, composeTemplate: true },
        }),
        'Service',
        reply
      );
      if (!service) return;

      return { template: service.composeTemplate };
    }
  );

  fastify.put(
    '/api/services/:id/compose/template',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Set a custom compose template for a service',
        params: idParamSchema,
        body: composeTemplateSchema,
        errors: [400, 401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(composeTemplateSchema, request, reply);
      if (!body) return;

      try {
        const service = await prisma.service.update({
          where: { id },
          data: { composeTemplate: body.composeTemplate },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Delete the custom compose template (revert to auto-generated)',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get the artifacts produced by a specific deployment',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const deployment = await findOrNotFound(
        prisma.deployment.findUnique({ where: { id } }),
        'Deployment',
        reply
      );
      if (!deployment) return;

      const artifacts = await getDeploymentArtifacts(id);
      return { artifacts };
    }
  );

  // Download a specific artifact
  fastify.get(
    '/api/artifacts/:id/download',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Download a single deployment artifact',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const artifact = await findOrNotFound(
        prisma.deploymentArtifact.findUnique({ where: { id } }),
        'Artifact',
        reply
      );
      if (!artifact) return;

      reply.header('Content-Type', 'text/plain');
      reply.header('Content-Disposition', `attachment; filename="${artifact.name}"`);
      return artifact.content;
    }
  );
}
