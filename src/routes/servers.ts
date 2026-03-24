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
  pruneServerImages,
} from '../services/servers.js';
import { logAudit } from '../services/audit.js';
import { deployAgent, removeAgent, checkAgentStatus } from '../services/agent-deploy.js';
import { getHostInfo, registerHostServer } from '../services/host-detection.js';
import { prisma } from '../lib/db.js';
import { bundledAgentVersion } from '../lib/version.js';
import { requireAdmin } from '../plugins/authorize.js';
import { METRICS_MODE } from '../lib/constants.js';
import { safeJsonParse, validateBody, findOrNotFound, handleUniqueConstraint, getErrorMessage, parsePaginationQuery } from '../lib/helpers.js';

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
  dockerMode: z.enum(['socket', 'ssh']).optional(),
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
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);
      const result = await listServers(envId, {
        limit,
        offset,
      });
      return result;
    }
  );

  // Get server with services
  fastify.get(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const server = await findOrNotFound(getServer(id), 'Server', reply);
      if (!server) return;

      return { server };
    }
  );

  // Create server
  fastify.post(
    '/api/environments/:envId/servers',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createServerSchema, request, reply);
      if (!body) return;

      try {
        const server = await createServer(envId, body);

        await logAudit({
          action: 'create',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { hostname: server.hostname, tags: body.tags },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { server };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Server already exists', reply)) return;
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
      const body = validateBody(updateServerSchema, request, reply);
      if (!body) return;

      try {
        const existing = await getServer(id);
        const server = await updateServer(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { changes: body },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { server };
      } catch {
        return reply.code(404).send({ error: 'Server not found' });
      }
    }
  );

  // Delete server (admin only)
  fastify.delete(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
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
        console.log(`[Discover] Server ${server?.name}: dockerMode=${server?.dockerMode}, serverType=${server?.serverType}`);
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
        console.error(`[Discover] Failed for server ${id}:`, error);
        return reply.code(500).send({ error: getErrorMessage(error, 'Discovery failed') });
      }
    }
  );

  // Import servers from Terraform output
  fastify.post(
    '/api/environments/:envId/servers/import-terraform',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(importTerraformSchema, request, reply);
      if (!body) return;

      try {
        const servers = await importFromTerraform(envId, body);

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
        return reply.code(500).send({ error: getErrorMessage(error, 'Import failed') });
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

      const server = await findOrNotFound(prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      }), 'Server', reply);
      if (!server) return;

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

      const server = await findOrNotFound(prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      }), 'Server', reply);
      if (!server) return;

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

      const server = await findOrNotFound(prisma.server.findUnique({ where: { id } }), 'Server', reply);
      if (!server) return;

      const status = await checkAgentStatus(id);
      return {
        metricsMode: server.metricsMode,
        hasToken: !!server.agentToken,
        agentStatus: server.agentStatus,
        agentVersion: server.agentVersion,
        lastAgentPushAt: server.lastAgentPushAt,
        bundledAgentVersion,
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

      if (![METRICS_MODE.SSH, METRICS_MODE.AGENT, METRICS_MODE.DISABLED].includes(body.mode)) {
        return reply.code(400).send({ error: 'Invalid mode. Must be ssh, agent, or disabled' });
      }

      const server = await findOrNotFound(prisma.server.findUnique({
        where: { id },
        include: { environment: true },
      }), 'Server', reply);
      if (!server) return;

      // If switching to agent mode, deploy the agent
      if (body.mode === METRICS_MODE.AGENT && server.metricsMode !== METRICS_MODE.AGENT) {
        const deployResult = await deployAgent(id);
        if (!deployResult.success) {
          return reply.code(500).send({ error: `Failed to deploy agent: ${deployResult.error}` });
        }
      }

      // If switching away from agent mode, remove the agent
      if (body.mode !== METRICS_MODE.AGENT && server.metricsMode === METRICS_MODE.AGENT) {
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

  // Get server process snapshot (from agent)
  fastify.get(
    '/api/servers/:id/processes',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await findOrNotFound(prisma.server.findUnique({
        where: { id },
        include: {
          processSnapshot: true,
        },
      }), 'Server', reply);
      if (!server) return;

      if (!server.processSnapshot) {
        return {
          hasData: false,
          processes: null,
          updatedAt: null,
        };
      }

      const processes = safeJsonParse(server.processSnapshot.data, {});
      const hasData = Object.keys(processes).length > 0;
      return {
        hasData,
        processes: hasData ? processes : null,
        updatedAt: hasData ? server.processSnapshot.updatedAt : null,
      };
    }
  );

  // Prune unused Docker images on server to reclaim disk space
  fastify.post(
    '/api/servers/:id/prune-images',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { mode?: 'dangling' | 'all' } | undefined;
      const mode = body?.mode === 'all' ? 'all' : 'dangling';

      const server = await findOrNotFound(prisma.server.findUnique({
        where: { id },
        select: { id: true, name: true, hostname: true, dockerMode: true, serverType: true, environmentId: true },
      }), 'Server', reply);
      if (!server) return;

      try {
        const { spaceReclaimedBytes } = await pruneServerImages(server, mode);

        await logAudit({
          action: 'prune_images',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { mode, spaceReclaimedBytes },
          userId: request.authUser!.id,
          environmentId: server.environmentId,
        });

        return { success: true, spaceReclaimedBytes, spaceReclaimedHuman: formatBytes(spaceReclaimedBytes) };
      } catch (error) {
        return reply.code(500).send({ error: getErrorMessage(error, 'Failed to prune images') });
      }
    }
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}
