import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import { logAudit } from '../services/audit.js';
import {
  parseTemplateDefinition,
  buildTemplatePreview,
  executeTemplate,
  type TemplateDefinition,
} from '../services/template-execution.js';
import {
  parseTemplateYaml,
  serializeTemplateYaml,
  validateTemplateDefinition,
} from '../services/template-yaml.js';

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  definition: z.string(), // JSON string of TemplateDefinition
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  definition: z.string().optional(), // JSON string of TemplateDefinition
});

const previewSchema = z.object({
  targetTag: z.string().min(1),
});

const executeSchema = z.object({
  targetTag: z.string().min(1),
});

const importYamlSchema = z.object({
  yaml: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
});

export async function deploymentTemplateRoutes(fastify: FastifyInstance): Promise<void> {
  // List templates for environment
  fastify.get(
    '/api/environments/:envId/deployment-templates',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const templates = await prisma.deploymentTemplate.findMany({
        where: { environmentId: envId },
        orderBy: { name: 'asc' },
        include: {
          createdBy: {
            select: { id: true, email: true, name: true },
          },
        },
      });

      return { templates };
    }
  );

  // Create template
  fastify.post(
    '/api/environments/:envId/deployment-templates',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createTemplateSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Validate the definition
      try {
        const definition = parseTemplateDefinition(body.data.definition);
        const errors = validateTemplateDefinition(definition);
        if (errors.length > 0) {
          return reply.code(400).send({ error: 'Invalid template definition', details: errors });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON';
        return reply.code(400).send({ error: `Invalid template definition: ${message}` });
      }

      try {
        const template = await prisma.deploymentTemplate.create({
          data: {
            name: body.data.name,
            description: body.data.description,
            definition: body.data.definition,
            environmentId: envId,
            createdById: request.authUser!.id,
          },
          include: {
            createdBy: { select: { id: true, email: true, name: true } },
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'deployment_template',
          resourceId: template.id,
          resourceName: template.name,
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { template };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'A template with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Get template
  fastify.get(
    '/api/environments/:envId/deployment-templates/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };

      const template = await prisma.deploymentTemplate.findFirst({
        where: { id, environmentId: envId },
        include: {
          createdBy: { select: { id: true, email: true, name: true } },
          deploymentPlans: {
            take: 10,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              name: true,
              status: true,
              imageTag: true,
              createdAt: true,
            },
          },
        },
      });

      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      return { template };
    }
  );

  // Update template
  fastify.patch(
    '/api/environments/:envId/deployment-templates/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };
      const body = updateTemplateSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Validate the definition if provided
      if (body.data.definition) {
        try {
          const definition = parseTemplateDefinition(body.data.definition);
          const errors = validateTemplateDefinition(definition);
          if (errors.length > 0) {
            return reply.code(400).send({ error: 'Invalid template definition', details: errors });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid JSON';
          return reply.code(400).send({ error: `Invalid template definition: ${message}` });
        }
      }

      try {
        const template = await prisma.deploymentTemplate.update({
          where: { id },
          data: body.data,
          include: {
            createdBy: { select: { id: true, email: true, name: true } },
          },
        });

        await logAudit({
          action: 'update',
          resourceType: 'deployment_template',
          resourceId: template.id,
          resourceName: template.name,
          details: { changes: Object.keys(body.data) },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { template };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Template not found' });
        }
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'A template with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Delete template
  fastify.delete(
    '/api/environments/:envId/deployment-templates/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };

      try {
        const template = await prisma.deploymentTemplate.delete({
          where: { id },
        });

        await logAudit({
          action: 'delete',
          resourceType: 'deployment_template',
          resourceId: id,
          resourceName: template.name,
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Template not found' });
        }
        throw error;
      }
    }
  );

  // Preview template execution
  fastify.post(
    '/api/environments/:envId/deployment-templates/:id/preview',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };
      const body = previewSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const template = await prisma.deploymentTemplate.findFirst({
        where: { id, environmentId: envId },
      });

      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      try {
        const preview = await buildTemplatePreview(id, body.data.targetTag);
        return { preview };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Preview failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Execute template
  fastify.post(
    '/api/environments/:envId/deployment-templates/:id/execute',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };
      const body = executeSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const template = await prisma.deploymentTemplate.findFirst({
        where: { id, environmentId: envId },
      });

      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      try {
        const result = await executeTemplate(
          id,
          body.data.targetTag,
          request.authUser!.email,
          request.authUser!.id
        );

        await logAudit({
          action: 'execute',
          resourceType: 'deployment_template',
          resourceId: id,
          resourceName: template.name,
          details: { targetTag: body.data.targetTag, planId: result.planId },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Execution failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Export template as YAML
  fastify.get(
    '/api/environments/:envId/deployment-templates/:id/export',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };

      const template = await prisma.deploymentTemplate.findFirst({
        where: { id, environmentId: envId },
      });

      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      try {
        const definition = parseTemplateDefinition(template.definition);
        const yaml = serializeTemplateYaml(definition);

        // Add metadata as YAML comments
        const header = `# Template: ${template.name}\n` +
          (template.description ? `# Description: ${template.description}\n` : '') +
          `# Exported: ${new Date().toISOString()}\n\n`;

        return { yaml: header + yaml };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Export failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Import template from YAML
  fastify.post(
    '/api/environments/:envId/deployment-templates/import',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = importYamlSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const definition = parseTemplateYaml(body.data.yaml);
        const errors = validateTemplateDefinition(definition);

        if (errors.length > 0) {
          return reply.code(400).send({ error: 'Invalid template YAML', details: errors });
        }

        // Extract name from YAML comment if not provided
        let name = body.data.name;
        if (!name) {
          const nameMatch = body.data.yaml.match(/^#\s*Template:\s*(.+)$/m);
          name = nameMatch ? nameMatch[1].trim() : `Imported Template ${Date.now()}`;
        }

        // Extract description from YAML comment if not provided
        let description = body.data.description;
        if (!description) {
          const descMatch = body.data.yaml.match(/^#\s*Description:\s*(.+)$/m);
          description = descMatch ? descMatch[1].trim() : undefined;
        }

        const template = await prisma.deploymentTemplate.create({
          data: {
            name,
            description,
            definition: JSON.stringify(definition),
            environmentId: envId,
            createdById: request.authUser!.id,
          },
          include: {
            createdBy: { select: { id: true, email: true, name: true } },
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'deployment_template',
          resourceId: template.id,
          resourceName: template.name,
          details: { source: 'yaml_import' },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { template };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Import failed';
        return reply.code(400).send({ error: message });
      }
    }
  );
}
