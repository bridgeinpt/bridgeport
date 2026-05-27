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
import { logAudit, actorFrom } from '../services/audit.js';
import { deployAgent, removeAgent, checkAgentStatus } from '../services/agent-deploy.js';
import { getHostInfo, registerHostServer } from '../services/host-detection.js';
import {
  runBootstrap,
  addSwapLive,
  detectDistro,
  preflightSudo,
  tryAcquireBootstrapLock,
  releaseBootstrapLock,
  SWAP_MIN_MB,
  SWAP_MAX_MB,
} from '../services/bootstrap.js';
import { createClientForServer } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { prisma } from '../lib/db.js';
import { bundledAgentVersion } from '../lib/version.js';
import { requireAdmin, requireOperator } from '../plugins/authorize.js';
import { METRICS_MODE } from '../lib/constants.js';
import { safeJsonParse, validateBody, validateUpdateBody, findOrNotFound, handleUniqueConstraint, getErrorMessage, parsePaginationQuery, flattenDeploymentOntoService } from '../lib/helpers.js';

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
  // `null` clears the cluster association, omit to leave unchanged.
  // Empty strings are rejected at the boundary so Prisma never sees a bogus FK.
  clusterId: z.string().min(1).nullable().optional(),
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

// Bootstrap schemas (issue #113)
const bootstrapRunSchema = z.object({
  components: z.object({
    docker: z.boolean().optional(),
    sysctl: z.boolean().optional(),
    agent: z.boolean().optional(),
    swap: z.boolean().optional(),
  }).refine(
    (c) => c.docker || c.sysctl || c.agent || c.swap,
    'At least one component must be selected',
  ),
  swapSizeMb: z.number().int().min(SWAP_MIN_MB).max(SWAP_MAX_MB).optional(),
}).refine(
  (body) => !body.components.swap || typeof body.swapSizeMb === 'number',
  { message: 'swapSizeMb is required when swap component is selected', path: ['swapSizeMb'] },
);

const bootstrapSwapSchema = z.object({
  sizeMb: z.number().int().min(SWAP_MIN_MB).max(SWAP_MAX_MB),
  confirm: z.literal(true),
  force: z.boolean().optional(),
});

export async function serverRoutes(fastify: FastifyInstance): Promise<void> {
  // List servers for environment.
  // Optional `?include=services-count` adds a `_count: { services }` field per server.
  fastify.get(
    '/api/environments/:envId/servers',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const query = request.query as Record<string, unknown>;
      const { limit, offset } = parsePaginationQuery(query);
      const include = typeof query.include === 'string' ? query.include : '';
      const result = await listServers(envId, {
        limit,
        offset,
        includeServicesCount: include === 'services-count',
      });
      return result;
    }
  );

  // Get server. By default returns just the server row.
  // Optional `?include=services` nests services + their containerImage.
  fastify.get(
    '/api/servers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, unknown>;
      const include = typeof query.include === 'string' ? query.include : '';
      const wantServices = include === 'services';
      const server = await findOrNotFound(
        getServer(id, { includeServices: wantServices }),
        'Server',
        reply
      );
      if (!server) return;

      // Back-compat: when the caller asked for services, expose a flattened
      // `services` array (one entry per deployment) so legacy UI code that reads
      // server.services keeps working. Default (thin) response omits it.
      if (wantServices && 'serviceDeployments' in server) {
        const services = server.serviceDeployments.map((d) => flattenDeploymentOntoService(d));
        return { server: { ...server, services } };
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
          ...actorFrom(request),
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
      // Rejects PATCH of derived fields (status, agentStatus, lastCheckedAt,
      // metricsMode — has a dedicated endpoint, etc.) with 422 BEFORE any DB
      // read/write. See src/lib/readonly-fields.ts.
      const body = validateUpdateBody(updateServerSchema, 'server', request, reply);
      if (!body) return;

      try {
        const existing = await getServer(id);
        if (!existing) {
          return reply.code(404).send({ error: 'Server not found' });
        }

        // When the caller is re-parenting under a cluster, the cluster must
        // exist AND belong to the same environment as the server. The FK only
        // enforces existence, so without this check a cross-env clusterId
        // silently corrupts environment isolation.
        if (typeof body.clusterId === 'string' && body.clusterId.length > 0) {
          const cluster = await prisma.serverCluster.findUnique({
            where: { id: body.clusterId },
            select: { environmentId: true },
          });
          if (!cluster) {
            return reply.code(404).send({ error: 'Cluster not found' });
          }
          if (cluster.environmentId !== existing.environmentId) {
            return reply
              .code(400)
              .send({ error: 'Cluster belongs to a different environment' });
          }
        }

        const server = await updateServer(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { changes: body },
          ...actorFrom(request),
          environmentId: existing.environmentId,
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
            ...actorFrom(request),
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
        const { serviceDeployments, missing } = await discoverContainers(id);

        await logAudit({
          action: 'discover',
          resourceType: 'server',
          resourceId: id,
          resourceName: server?.name,
          details: {
            discoveredServices: serviceDeployments.length,
            missingServices: missing,
          },
          ...actorFrom(request),
          environmentId: server?.environmentId,
        });

        // Back-compat: surface a flattened services array so legacy UI keeps working.
        // Re-fetch deployments with the service template + containerImage joined.
        const enrichedDeployments = await prisma.serviceDeployment.findMany({
          where: { serverId: id },
          include: { service: { include: { containerImage: true } } },
          orderBy: { service: { name: 'asc' } },
        });
        const services = enrichedDeployments.map((d) => flattenDeploymentOntoService(d));
        return { serviceDeployments, missing, services };
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
          ...actorFrom(request),
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
        ...actorFrom(request),
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
        ...actorFrom(request),
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
        ...actorFrom(request),
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
        ...actorFrom(request),
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

  // ==================== Bootstrap (issue #113) ====================

  // GET bootstrap status: per-component flags, timestamps, distro, current memory.
  // Returns cached state immediately; runs a live distro/sudo/free probe in the
  // background only if a client can be created (best-effort).
  //
  // Operator+ required: the live probe fires SSH commands (distro detect, sudo
  // preflight, `free -m`) which is a state-mutating side effect of a GET on
  // viewer access. Read-only callers should rely on the cached fields exposed
  // via GET /api/environments/:id.
  fastify.get(
    '/api/servers/:id/bootstrap',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const server = await findOrNotFound(
        prisma.server.findUnique({ where: { id } }),
        'Server',
        reply,
      );
      if (!server) return;

      const cached = {
        bootstrapState: server.bootstrapState,
        bootstrapDistro: server.bootstrapDistro,
        dockerInstalled: server.dockerInstalled,
        dockerInstalledAt: server.dockerInstalledAt,
        // agentInstalled reflects whether the agent binary was actually
        // installed (timestamp set by deployAgent / bootstrap). It must not
        // flip to false when an admin toggles metricsMode to ssh.
        agentInstalled: server.agentInstalledAt !== null,
        agentInstalledAt: server.agentInstalledAt,
        sysctlApplied: server.sysctlApplied,
        sysctlAppliedAt: server.sysctlAppliedAt,
        swapConfigured: server.swapConfigured,
        swapConfiguredAt: server.swapConfiguredAt,
        swapSizeMb: server.swapSizeMb,
      };

      // Best-effort live probe — distro detect + free -m. Failures are silent;
      // the cached fields still render.
      const { client } = await createClientForServer(
        server.hostname,
        server.environmentId,
        getEnvironmentSshKey,
        { serverType: server.serverType },
      );
      if (!client) return { ...cached, distro: null, memory: null, sudo: null };
      try {
        await client.connect();
        const [distro, sudo, mem] = await Promise.all([
          detectDistro(client, id, server.bootstrapDistro).catch(() => null),
          preflightSudo(client).catch(() => null),
          client.exec('free -m').catch(() => null),
        ]);
        return {
          ...cached,
          distro,
          sudo,
          memory: mem?.stdout ?? null,
        };
      } catch (err) {
        return { ...cached, distro: null, memory: null, sudo: null, probeError: getErrorMessage(err) };
      } finally {
        client.disconnect();
      }
    },
  );

  // POST bootstrap: kick off a bootstrap run in the background. Returns 202
  // immediately with `{ started: true }`. Operator+ role required because this
  // changes system state and can install Docker / write to /etc/fstab.
  fastify.post(
    '/api/servers/:id/bootstrap',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(bootstrapRunSchema, request, reply);
      if (!body) return;

      const server = await findOrNotFound(
        prisma.server.findUnique({ where: { id } }),
        'Server',
        reply,
      );
      if (!server) return;

      // Atomically acquire the bootstrap lock. Two parallel POSTs can both
      // pass an `isRunning` check (await yields between check and run), so we
      // grab the lock synchronously here and let runBootstrap release it.
      if (!tryAcquireBootstrapLock(id)) {
        return reply.code(409).send({ error: 'Bootstrap already running for this server' });
      }

      const actor = actorFrom(request);
      try {
        await logAudit({
          action: 'bootstrap_start',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { components: body.components, swapSizeMb: body.swapSizeMb },
          ...actor,
          environmentId: server.environmentId,
        });
      } catch (err) {
        // If the audit write fails, drop the lock so the bootstrap isn't
        // permanently blocked by an orphaned reservation.
        releaseBootstrapLock(id);
        throw err;
      }

      // Fire-and-forget — progress streams via the SSE event bus. Pass the
      // `_lockHeldByCaller` flag so runBootstrap proceeds (rather than seeing
      // the lock as held by someone else) and still releases on completion.
      void runBootstrap(id, {
        components: body.components,
        swapSizeMb: body.swapSizeMb,
        actor,
        _lockHeldByCaller: true,
      }).catch((err) => {
        // The catch in runBootstrap's outer finally normally releases the
        // lock; release defensively here too in case the function threw
        // before reaching its own finally.
        releaseBootstrapLock(id);
        console.error('[bootstrap] background run threw:', err);
      });

      reply.code(202);
      return { started: true };
    },
  );

  // POST /bootstrap/swap: live-add a swap file outside the full bootstrap flow.
  // Requires explicit `confirm: true` so accidental clicks don't write fstab.
  fastify.post(
    '/api/servers/:id/bootstrap/swap',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(bootstrapSwapSchema, request, reply);
      if (!body) return;

      const server = await findOrNotFound(
        prisma.server.findUnique({ where: { id } }),
        'Server',
        reply,
      );
      if (!server) return;

      const actor = actorFrom(request);
      const result = await addSwapLive(id, body.sizeMb, { force: body.force, actor });

      if (!result.success) {
        return reply.code(400).send({
          error: result.error ?? 'Failed to configure swap',
          before: result.before,
        });
      }

      return { success: true, before: result.before, after: result.after };
    },
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
          ...actorFrom(request),
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
