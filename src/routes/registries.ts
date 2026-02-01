import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  createRegistryConnection,
  updateRegistryConnection,
  getRegistryConnection,
  listRegistryConnections,
  deleteRegistryConnection,
  getRegistryCredentials,
} from '../services/registries.js';
import { RegistryFactory } from '../lib/registry.js';
import { logAudit } from '../services/audit.js';

const registryTypeSchema = z.enum(['digitalocean', 'dockerhub', 'generic']);

const createRegistrySchema = z.object({
  name: z.string().min(1),
  type: registryTypeSchema,
  registryUrl: z.string().min(1),
  repositoryPrefix: z.string().optional(),
  token: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  isDefault: z.boolean().optional(),
  refreshIntervalMinutes: z.number().min(5).max(1440).optional(),
  autoLinkPattern: z.string().optional(),
});

const updateRegistrySchema = z.object({
  name: z.string().min(1).optional(),
  type: registryTypeSchema.optional(),
  registryUrl: z.string().min(1).optional(),
  repositoryPrefix: z.string().nullable().optional(),
  token: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  refreshIntervalMinutes: z.number().min(5).max(1440).optional(),
  autoLinkPattern: z.string().nullable().optional(),
});

export async function registryRoutes(fastify: FastifyInstance) {
  // List registry connections for environment
  fastify.get(
    '/api/environments/:envId/registries',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const registries = await listRegistryConnections(envId);
      return { registries };
    }
  );

  // Create registry connection
  fastify.post(
    '/api/environments/:envId/registries',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createRegistrySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const registry = await createRegistryConnection(envId, body.data);

        await logAudit({
          action: 'create',
          resourceType: 'registry_connection',
          resourceId: registry.id,
          resourceName: registry.name,
          details: { type: registry.type, registryUrl: registry.registryUrl },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { registry };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Registry connection with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Get registry connection
  fastify.get(
    '/api/registries/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const registry = await getRegistryConnection(id);

      if (!registry) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      return { registry };
    }
  );

  // Update registry connection
  fastify.patch(
    '/api/registries/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateRegistrySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await getRegistryConnection(id);
        const registry = await updateRegistryConnection(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'registry_connection',
          resourceId: registry.id,
          resourceName: registry.name,
          details: { changes: Object.keys(body.data) },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { registry };
      } catch (error) {
        if (error instanceof Error && error.message === 'Registry connection not found') {
          return reply.code(404).send({ error: 'Registry connection not found' });
        }
        throw error;
      }
    }
  );

  // Delete registry connection
  fastify.delete(
    '/api/registries/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await getRegistryConnection(id);
      if (!existing) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      if (existing._count && existing._count.services > 0) {
        return reply.code(400).send({
          error: `Cannot delete registry connection with ${existing._count.services} service(s) attached`,
        });
      }

      await deleteRegistryConnection(id);

      await logAudit({
        action: 'delete',
        resourceType: 'registry_connection',
        resourceId: id,
        resourceName: existing.name,
        userId: request.authUser!.id,
        environmentId: existing.environmentId,
      });

      return { success: true };
    }
  );

  // Test registry connection
  fastify.post(
    '/api/registries/:id/test',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const creds = await getRegistryCredentials(id);
      if (!creds) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      try {
        const client = RegistryFactory.create(creds);
        await client.testConnection();

        return { success: true, message: 'Connection successful' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection test failed';
        return reply.code(400).send({ success: false, error: message });
      }
    }
  );

  // List repositories in registry
  fastify.get(
    '/api/registries/:id/repositories',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const creds = await getRegistryCredentials(id);
      if (!creds) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      try {
        const client = RegistryFactory.create(creds);
        const repositories = await client.listRepositories();
        return { repositories };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list repositories';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // List tags for a repository
  fastify.get(
    '/api/registries/:id/repositories/:repo/tags',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id, repo } = request.params as { id: string; repo: string };

      const creds = await getRegistryCredentials(id);
      if (!creds) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      try {
        const client = RegistryFactory.create(creds);
        const tags = await client.listTags(repo);
        return { tags };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list tags';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // List services using this registry
  fastify.get(
    '/api/registries/:id/services',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const registry = await getRegistryConnection(id);
      if (!registry) {
        return reply.code(404).send({ error: 'Registry connection not found' });
      }

      const services = await prisma.service.findMany({
        where: { registryConnectionId: id },
        select: {
          id: true,
          name: true,
          imageName: true,
          imageTag: true,
          server: {
            select: { id: true, name: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      return { services };
    }
  );
}
