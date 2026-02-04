import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createServer,
  updateServer,
  getServer,
  listServers,
  deleteServer,
  checkServerHealth,
  discoverContainers,
  importFromTerraform,
} from '../services/servers.js';
import { logAudit } from '../services/audit.js';
import { deployAgent, removeAgent, checkAgentStatus } from '../services/agent-deploy.js';
import { getHostInfo, registerHostServer } from '../services/host-detection.js';
import { prisma } from '../lib/db.js';

const createServerSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().min(1),
  publicIp: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  publicIp: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

const importTerraformSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      private_ip: z.string(),
      public_ip: z.string().nullable().optional(),
      tags: z.array(z.string()),
      services: z.array(
        z.object({
          name: z.string(),
          container_name: z.string(),
          image_name: z.string(),
          image_tag: z.string().default('latest'),
          compose_path: z.string().nullable().optional(),
          health_check_url: z.string().nullable().optional(),
        })
      ).optional(),
    })
  ),
});

const registerHostSchema = z.object({
  name: z.string().min(1).default('host'),
});

export async function serverRoutes(fastify: FastifyInstance): Promise<void> {
  // List servers for environment
  fastify.get(
    '/api/environments/:envId/servers',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const servers = await listServers(envId);
      return { servers };
    }
  );

  // Get server with services
  fastify.get(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const server = await getServer(id);

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      return { server };
    }
  );

  // Create server
  fastify.post(
    '/api/environments/:envId/servers',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createServerSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const server = await createServer(envId, body.data);

        await logAudit({
          action: 'create',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { hostname: server.hostname, tags: body.data.tags },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { server };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Server already exists' });
        }
        throw error;
      }
    }
  );

  // Update server
  fastify.patch(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateServerSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await getServer(id);
        const server = await updateServer(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { changes: body.data },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { server };
      } catch {
        return reply.code(404).send({ error: 'Server not found' });
      }
    }
  );

  // Delete server
  fastify.delete(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const server = await getServer(id);
        await deleteServer(id);

        if (server) {
          await logAudit({
            action: 'delete',
            resourceType: 'server',
            resourceId: id,
            resourceName: server.name,
            userId: request.authUser!.id,
            environmentId: server.environmentId,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Server not found' });
      }
    }
  );

  // Check server health
  fastify.post(
    '/api/servers/:id/health',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await checkServerHealth(id);
        return result;
      } catch (error) {
        return reply.code(404).send({ error: 'Server not found' });
      }
    }
  );

  // Discover containers on server
  fastify.post(
    '/api/servers/:id/discover',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const server = await getServer(id);
        const { services, missing } = await discoverContainers(id);

        await logAudit({
          action: 'discover',
          resourceType: 'server',
          resourceId: id,
          resourceName: server?.name,
          details: {
            discoveredServices: services.length,
            missingServices: missing,
          },
          userId: request.authUser!.id,
          environmentId: server?.environmentId,
        });

        return { services, missing };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Discovery failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Import servers from Terraform output
  fastify.post(
    '/api/environments/:envId/servers/import-terraform',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = importTerraformSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const servers = await importFromTerraform(envId, body.data);

        await logAudit({
          action: 'import',
          resourceType: 'server',
          resourceName: 'terraform-import',
          details: { importedServers: servers.map(s => s.name) },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { servers, imported: servers.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Import failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Deploy monitoring agent to server
  fastify.post(
    '/api/servers/:id/agent/deploy',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { bridgeportUrl?: string } | undefined;

      const server = await prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      });

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const result = await deployAgent(id, body?.bridgeportUrl);

      await logAudit({
        action: 'deploy_agent',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { success: result.success, error: result.error },
        success: result.success,
        userId: request.authUser!.id,
        environmentId: server.environmentId,
      });

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      return { success: true, message: 'Agent deployed successfully' };
    }
  );

  // Remove monitoring agent from server
  fastify.post(
    '/api/servers/:id/agent/remove',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      });

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const result = await removeAgent(id);

      await logAudit({
        action: 'remove_agent',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { success: result.success, error: result.error },
        success: result.success,
        userId: request.authUser!.id,
        environmentId: server.environmentId,
      });

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      return { success: true, message: 'Agent removed successfully' };
    }
  );

  // Check agent status on server
  fastify.get(
    '/api/servers/:id/agent/status',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const status = await checkAgentStatus(id);
      return {
        metricsMode: server.metricsMode,
        hasToken: !!server.agentToken,
        agentStatus: server.agentStatus,
        agentVersion: server.agentVersion,
        lastAgentPushAt: server.lastAgentPushAt,
        ...status,
      };
    }
  );

  // Update server metrics mode
  fastify.patch(
    '/api/servers/:id/metrics-mode',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { mode: 'ssh' | 'agent' | 'disabled' };

      if (!['ssh', 'agent', 'disabled'].includes(body.mode)) {
        return reply.code(400).send({ error: 'Invalid mode. Must be ssh, agent, or disabled' });
      }

      const server = await prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      });

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      // If switching to agent mode, deploy the agent
      if (body.mode === 'agent' && server.metricsMode !== 'agent') {
        const deployResult = await deployAgent(id);
        if (!deployResult.success) {
          return reply.code(500).send({ error: `Failed to deploy agent: ${deployResult.error}` });
        }
      }

      // If switching away from agent mode, remove the agent
      if (body.mode !== 'agent' && server.metricsMode === 'agent') {
        await removeAgent(id);
      }

      // Update the mode
      const updated = await prisma.server.update({
        where: { id },
        data: { metricsMode: body.mode },
      });

      await logAudit({
        action: 'update_metrics_mode',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { oldMode: server.metricsMode, newMode: body.mode },
        userId: request.authUser!.id,
        environmentId: server.environmentId,
      });

      return {
        server: {
          id: updated.id,
          name: updated.name,
          metricsMode: updated.metricsMode,
          agentToken: updated.agentToken,
        },
      };
    }
  );

  // Get host detection info for environment
  // Detects Docker host gateway and checks SSH reachability
  fastify.get(
    '/api/environments/:envId/host-info',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const hostInfo = await getHostInfo(envId);
      return hostInfo;
    }
  );

  // Register Docker host as a server
  // Creates a server entry for managing the host machine from inside a container
  fastify.post(
    '/api/environments/:envId/servers/register-host',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = registerHostSchema.safeParse(request.body || {});

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const result = await registerHostServer(envId, body.data.name);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      const server = await getServer(result.serverId!);

      await logAudit({
        action: 'create',
        resourceType: 'server',
        resourceId: result.serverId!,
        resourceName: body.data.name,
        details: { type: 'host', hostname: server?.hostname },
        userId: request.authUser!.id,
        environmentId: envId,
      });

      return { server, success: true };
    }
  );
}
