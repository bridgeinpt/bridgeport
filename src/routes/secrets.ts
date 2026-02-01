import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  createSecret,
  updateSecret,
  getSecretValue,
  listSecrets,
  deleteSecret,
  generateEnvFile,
  createEnvTemplate,
  updateEnvTemplate,
  listEnvTemplates,
  getEnvTemplate,
  deleteEnvTemplate,
} from '../services/secrets.js';
import { logAudit } from '../services/audit.js';

const createSecretSchema = z.object({
  key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase with underscores'),
  value: z.string().min(1),
  description: z.string().optional(),
});

const updateSecretSchema = z.object({
  value: z.string().min(1).optional(),
  description: z.string().optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  template: z.string().min(1),
});

export async function secretRoutes(fastify: FastifyInstance) {
  // List secrets (without values)
  fastify.get(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const secrets = await listSecrets(envId);
      return { secrets };
    }
  );

  // Create secret
  fastify.post(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createSecretSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const secret = await createSecret(envId, body.data);

        await logAudit({
          action: 'create',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { secret };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Secret already exists' });
        }
        throw error;
      }
    }
  );

  // Get secret value (requires explicit action)
  fastify.get(
    '/api/secrets/:id/value',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await prisma.secret.findUnique({ where: { id } });
        const value = await getSecretValue(id);

        await logAudit({
          action: 'access',
          resourceType: 'secret',
          resourceId: id,
          resourceName: secret?.key,
          userId: request.authUser!.id,
          environmentId: secret?.environmentId,
        });

        return { value };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Update secret
  fastify.patch(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateSecretSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.secret.findUnique({ where: { id } });
        const secret = await updateSecret(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          details: { valueChanged: !!body.data.value, descriptionChanged: !!body.data.description },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { secret };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Delete secret
  fastify.delete(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await prisma.secret.findUnique({ where: { id } });
        await deleteSecret(id);

        if (secret) {
          await logAudit({
            action: 'delete',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            userId: request.authUser!.id,
            environmentId: secret.environmentId,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Generate .env file from template
  fastify.post(
    '/api/environments/:envId/generate-env',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const { templateName } = request.body as { templateName: string };

      if (!templateName) {
        return reply.code(400).send({ error: 'templateName is required' });
      }

      try {
        const envContent = await generateEnvFile(envId, templateName);
        return { content: envContent };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Generation failed';
        return reply.code(400).send({ error: message });
      }
    }
  );

  // List env templates
  fastify.get(
    '/api/env-templates',
    { preHandler: [fastify.authenticate] },
    async () => {
      const templates = await listEnvTemplates();
      return { templates };
    }
  );

  // Get env template
  fastify.get(
    '/api/env-templates/:name',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const template = await getEnvTemplate(name);

      if (!template) {
        return reply.code(404).send({ error: 'Template not found' });
      }

      return { template };
    }
  );

  // Create env template
  fastify.post(
    '/api/env-templates',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = createTemplateSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const template = await createEnvTemplate(body.data.name, body.data.template);

        await logAudit({
          action: 'create',
          resourceType: 'env_template',
          resourceId: template.id,
          resourceName: template.name,
          userId: request.authUser!.id,
        });

        return { template };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Template already exists' });
        }
        throw error;
      }
    }
  );

  // Update env template
  fastify.put(
    '/api/env-templates/:name',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const { template } = request.body as { template: string };

      if (!template) {
        return reply.code(400).send({ error: 'template content is required' });
      }

      try {
        const updated = await updateEnvTemplate(name, template);

        await logAudit({
          action: 'update',
          resourceType: 'env_template',
          resourceId: updated.id,
          resourceName: updated.name,
          userId: request.authUser!.id,
        });

        return { template: updated };
      } catch {
        return reply.code(404).send({ error: 'Template not found' });
      }
    }
  );

  // Delete env template
  fastify.delete(
    '/api/env-templates/:name',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { name } = request.params as { name: string };

      try {
        const template = await getEnvTemplate(name);
        await deleteEnvTemplate(name);

        if (template) {
          await logAudit({
            action: 'delete',
            resourceType: 'env_template',
            resourceId: template.id,
            resourceName: template.name,
            userId: request.authUser!.id,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Template not found' });
      }
    }
  );
}
