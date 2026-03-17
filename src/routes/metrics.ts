import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  collectServerMetricsSSH,
  saveServerMetrics,
  saveServiceMetrics,
  getServerMetrics,
  getServiceMetrics,
  getEnvironmentMetricsSummary,
} from '../services/metrics.js';
import { logAudit } from '../services/audit.js';
import { getSchedulerConfig } from '../services/health-checks.js';
import { deployAgent } from '../services/agent-deploy.js';
import { logAgentEvent } from '../services/agent-events.js';
import crypto from 'crypto';
import { SERVER_STATUS, HEALTH_STATUS, CONTAINER_STATUS, METRICS_MODE, AGENT_STATUS, DISCOVERY_STATUS } from '../lib/constants.js';

const metricsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).optional(),
});

const serviceHealthCheckSchema = z.object({
  containerName: z.string(),
  healthCheckUrl: z.string(),
  success: z.boolean(),
  statusCode: z.number().optional(),
  durationMs: z.number().optional(),
  checkedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

const containerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  imageId: z.string(),
  state: z.string(),
  status: z.string(),
  created: z.number(),
  ports: z.array(z.object({
    privatePort: z.number(),
    publicPort: z.number().optional(),
    type: z.string(),
    ip: z.string().optional(),
  })).optional(),
  labels: z.record(z.string()).optional(),
  mounts: z.array(z.object({
    source: z.string(),
    destination: z.string(),
    mode: z.string(),
    type: z.string(),
  })).optional(),
  networkMode: z.string().optional(),
});

const processInfoSchema = z.object({
  pid: z.number(),
  name: z.string(),
  state: z.string(),
  cpuPercent: z.number(),
  memoryMb: z.number(),
  threads: z.number(),
});

const topProcessesSchema = z.object({
  byCpu: z.array(processInfoSchema),
  byMemory: z.array(processInfoSchema),
  stats: z.object({
    total: z.number(),
    running: z.number(),
    sleeping: z.number(),
    stopped: z.number(),
    zombie: z.number(),
  }),
});

const tcpCheckResultSchema = z.object({
  containerName: z.string(),
  host: z.string(),
  port: z.number(),
  name: z.string().optional(),
  success: z.boolean(),
  durationMs: z.number(),
  error: z.string().optional(),
});

const certCheckResultSchema = z.object({
  containerName: z.string(),
  host: z.string(),
  port: z.number(),
  name: z.string().optional(),
  success: z.boolean(),
  durationMs: z.number(),
  expiresAt: z.string().optional(),
  daysUntilExpiry: z.number().optional(),
  issuer: z.string().optional(),
  subject: z.string().optional(),
  error: z.string().optional(),
});

const serverMetricsIngestSchema = z.object({
  cpuPercent: z.number().optional(),
  memoryUsedMb: z.number().optional(),
  memoryTotalMb: z.number().optional(),
  swapUsedMb: z.number().optional(),
  swapTotalMb: z.number().optional(),
  diskUsedGb: z.number().optional(),
  diskTotalGb: z.number().optional(),
  loadAvg1: z.number().optional(),
  loadAvg5: z.number().optional(),
  loadAvg15: z.number().optional(),
  uptime: z.number().optional(),
  openFds: z.number().optional(),
  maxFds: z.number().optional(),
  tcpEstablished: z.number().optional(),
  tcpListen: z.number().optional(),
  tcpTimeWait: z.number().optional(),
  tcpCloseWait: z.number().optional(),
  tcpTotal: z.number().optional(),
  serverHealthy: z.boolean().optional(), // Agent confirms server is reachable
  agentVersion: z.string().optional(),   // Agent reports its version
  services: z
    .array(
      z.object({
        containerName: z.string(),
        cpuPercent: z.number().optional(),
        memoryUsedMb: z.number().optional(),
        memoryLimitMb: z.number().optional(),
        networkRxMb: z.number().optional(),
        networkTxMb: z.number().optional(),
        blockReadMb: z.number().optional(),
        blockWriteMb: z.number().optional(),
        restartCount: z.number().optional(),
        state: z.string().optional(),  // Container state: "running", "stopped", etc.
        health: z.string().optional(), // Health status: "healthy", "unhealthy", "none", ""
      })
    )
    .optional(),
  serviceHealthChecks: z.array(serviceHealthCheckSchema).optional(), // Agent-performed URL health checks
  tcpCheckResults: z.array(tcpCheckResultSchema).optional(), // Agent-performed TCP port checks
  certCheckResults: z.array(certCheckResultSchema).optional(), // Agent-performed TLS cert checks
  containers: z.array(containerInfoSchema).optional(), // Full container list for discovery
  topProcesses: topProcessesSchema.optional(), // Top processes by CPU/memory
});

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get metrics for a server
  fastify.get(
    '/api/servers/:id/metrics',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = metricsQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const metrics = await getServerMetrics(
        id,
        query.data.from ? new Date(query.data.from) : undefined,
        query.data.to ? new Date(query.data.to) : undefined,
        query.data.limit
      );

      return { metrics };
    }
  );

  // Get metrics for a service
  fastify.get(
    '/api/services/:id/metrics',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = metricsQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const service = await prisma.service.findUnique({ where: { id } });
      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      const metrics = await getServiceMetrics(
        id,
        query.data.from ? new Date(query.data.from) : undefined,
        query.data.to ? new Date(query.data.to) : undefined,
        query.data.limit
      );

      return { metrics };
    }
  );

  // Get environment metrics summary
  fastify.get(
    '/api/environments/:envId/metrics/summary',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const summary = await getEnvironmentMetricsSummary(envId);
      return { servers: summary };
    }
  );

  // Collect metrics for a server (manual trigger)
  fastify.post(
    '/api/servers/:id/collect-metrics',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await prisma.server.findUnique({
        where: { id },
        include: { services: true },
      });

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      if (server.metricsMode === METRICS_MODE.DISABLED) {
        return reply.code(400).send({ error: 'Metrics collection is disabled for this server' });
      }

      if (server.metricsMode === METRICS_MODE.AGENT) {
        return reply.code(400).send({ error: 'This server uses agent mode. Wait for agent to push metrics.' });
      }

      // Collect server metrics only (service metrics are agent-only now)
      const serverMetrics = await collectServerMetricsSSH(id);
      if (serverMetrics) {
        await saveServerMetrics(id, serverMetrics, 'ssh');
      }

      return {
        serverMetrics: serverMetrics ? 'collected' : 'failed',
        services: [], // Service metrics are now agent-only
      };
    }
  );

  // Agent metrics ingest endpoint (token auth)
  fastify.post('/api/metrics/ingest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.slice(7);

    // Find server by agent token
    const server = await prisma.server.findFirst({
      where: { agentToken: token, metricsMode: METRICS_MODE.AGENT },
      include: { services: true },
    });

    if (!server) {
      return reply.code(401).send({ error: 'Invalid agent token' });
    }

    const body = serverMetricsIngestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid metrics data', details: body.error.issues });
    }

    // Save server metrics (exclude non-metrics fields)
    const { services: serviceMetrics, serverHealthy, agentVersion, serviceHealthChecks, tcpCheckResults, certCheckResults, containers, topProcesses, ...serverMetricsData } = body.data;
    await saveServerMetrics(server.id, serverMetricsData, 'agent');

    // Save container snapshot for discovery (upsert)
    if (containers && containers.length > 0) {
      await prisma.agentContainerSnapshot.upsert({
        where: { serverId: server.id },
        create: {
          serverId: server.id,
          data: JSON.stringify(containers),
        },
        update: {
          data: JSON.stringify(containers),
        },
      });
    }

    // Save process snapshot (upsert)
    if (topProcesses) {
      await prisma.agentProcessSnapshot.upsert({
        where: { serverId: server.id },
        create: {
          serverId: server.id,
          data: JSON.stringify(topProcesses),
        },
        update: {
          data: JSON.stringify(topProcesses),
        },
      });
    }

    // Update server status: agent push means server is healthy and agent is active
    const now = new Date();
    const serverUpdateData: {
      status?: string;
      lastCheckedAt: Date;
      agentStatus: string;
      lastAgentPushAt: Date;
      agentVersion?: string;
      agentStatusChangedAt?: Date;
    } = {
      lastCheckedAt: now,
      agentStatus: AGENT_STATUS.ACTIVE,
      lastAgentPushAt: now,
    };

    // Track status change time if status is changing
    if (server.agentStatus !== AGENT_STATUS.ACTIVE) {
      serverUpdateData.agentStatusChangedAt = now;

      // Log status_change event when agent becomes active
      await logAgentEvent({
        serverId: server.id,
        eventType: 'status_change',
        status: AGENT_STATUS.ACTIVE,
        message: server.agentStatus === AGENT_STATUS.WAITING || server.agentStatus === AGENT_STATUS.DEPLOYING
          ? 'Agent connected for the first time'
          : 'Agent recovered and is now active',
        details: { previousStatus: server.agentStatus, version: agentVersion },
      });
    }

    // Set server health status if provided
    if (serverHealthy !== undefined) {
      serverUpdateData.status = serverHealthy ? SERVER_STATUS.HEALTHY : SERVER_STATUS.UNHEALTHY;
    }

    // Store agent version if provided
    if (agentVersion) {
      serverUpdateData.agentVersion = agentVersion;
    }

    await prisma.server.update({
      where: { id: server.id },
      data: serverUpdateData,
    });

    // Save service metrics and health if provided
    if (serviceMetrics && serviceMetrics.length > 0) {
      for (const sm of serviceMetrics) {
        const service = server.services.find((s) => s.containerName === sm.containerName);
        if (service) {
          const { containerName, state, health, ...metricsData } = sm;

          // Save metrics
          await saveServiceMetrics(service.id, metricsData);

          // Update service health status if provided
          if (state !== undefined || health !== undefined) {
            const isRunning = state === CONTAINER_STATUS.RUNNING;

            // Determine health status from container health
            let healthStatus: string = HEALTH_STATUS.UNKNOWN;
            if (!isRunning) {
              healthStatus = HEALTH_STATUS.UNKNOWN;
            } else if (health === HEALTH_STATUS.HEALTHY) {
              healthStatus = HEALTH_STATUS.HEALTHY;
            } else if (health === HEALTH_STATUS.UNHEALTHY) {
              healthStatus = HEALTH_STATUS.UNHEALTHY;
            } else if (health === HEALTH_STATUS.NONE || health === '') {
              healthStatus = HEALTH_STATUS.NONE;
            }

            // Determine overall status
            let status: string = CONTAINER_STATUS.RUNNING;
            if (!isRunning) {
              status = CONTAINER_STATUS.STOPPED;
            } else if (healthStatus === HEALTH_STATUS.UNHEALTHY) {
              status = SERVER_STATUS.UNHEALTHY;
            } else if (healthStatus === HEALTH_STATUS.HEALTHY) {
              status = SERVER_STATUS.HEALTHY;
            }

            await prisma.service.update({
              where: { id: service.id },
              data: {
                status,
                containerStatus: state || CONTAINER_STATUS.STOPPED,
                healthStatus,
                lastCheckedAt: new Date(),
              },
            });
          }
        }
      }
    }

    // Process agent-performed service health checks
    if (serviceHealthChecks && serviceHealthChecks.length > 0) {
      for (const hc of serviceHealthChecks) {
        const service = server.services.find((s) => s.containerName === hc.containerName);
        if (service) {
          await prisma.service.update({
            where: { id: service.id },
            data: {
              agentHealthSuccess: hc.success,
              agentHealthStatusCode: hc.statusCode ?? null,
              agentHealthDurationMs: hc.durationMs ?? null,
              agentHealthCheckedAt: hc.checkedAt ? new Date(hc.checkedAt) : now,
            },
          });
        }
      }
    }

    // Process agent-performed TCP port checks
    if (tcpCheckResults && tcpCheckResults.length > 0) {
      // Group results by container name
      const resultsByContainer = new Map<string, typeof tcpCheckResults>();
      for (const result of tcpCheckResults) {
        const existing = resultsByContainer.get(result.containerName) || [];
        existing.push(result);
        resultsByContainer.set(result.containerName, existing);
      }

      for (const [containerName, results] of resultsByContainer) {
        const service = server.services.find((s) => s.containerName === containerName);
        if (service) {
          await prisma.service.update({
            where: { id: service.id },
            data: {
              agentTcpCheckResults: JSON.stringify(results),
              agentTcpCheckedAt: now,
            },
          });
        }
      }
    }

    // Process agent-performed TLS certificate checks
    if (certCheckResults && certCheckResults.length > 0) {
      // Group results by container name
      const resultsByContainer = new Map<string, typeof certCheckResults>();
      for (const result of certCheckResults) {
        const existing = resultsByContainer.get(result.containerName) || [];
        existing.push(result);
        resultsByContainer.set(result.containerName, existing);
      }

      for (const [containerName, results] of resultsByContainer) {
        const service = server.services.find((s) => s.containerName === containerName);
        if (service) {
          await prisma.service.update({
            where: { id: service.id },
            data: {
              agentCertCheckResults: JSON.stringify(results),
              agentCertCheckedAt: now,
            },
          });
        }
      }
    }

    return { success: true };
  });

  // Get agent configuration (services with health check URLs for this server)
  fastify.get('/api/agent/config', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.slice(7);

    // Find server by agent token
    const server = await prisma.server.findFirst({
      where: { agentToken: token, metricsMode: METRICS_MODE.AGENT },
      include: {
        services: {
          where: { discoveryStatus: DISCOVERY_STATUS.FOUND },
          select: {
            id: true,
            containerName: true,
            healthCheckUrl: true,
            tcpChecks: true,
            certChecks: true,
          },
        },
      },
    });

    if (!server) {
      return reply.code(401).send({ error: 'Invalid agent token' });
    }

    // Get scheduler/metrics config for the environment
    const schedulerConfig = await getSchedulerConfig(server.environmentId);

    // Parse JSON fields for TCP and cert checks
    const parseChecks = (jsonStr: string | null): Array<{ host: string; port: number; name?: string }> => {
      if (!jsonStr) return [];
      try {
        return JSON.parse(jsonStr);
      } catch {
        return [];
      }
    };

    // Build service config including health checks
    const servicesConfig = server.services
      .filter((s) => s.healthCheckUrl || s.tcpChecks || s.certChecks)
      .map((s) => ({
        containerName: s.containerName,
        healthCheckUrl: s.healthCheckUrl,
        tcpChecks: parseChecks(s.tcpChecks),
        certChecks: parseChecks(s.certChecks),
      }));

    // Extract metrics config for the agent
    const metricsConfig = {
      collectCpu: schedulerConfig.collectCpu,
      collectMemory: schedulerConfig.collectMemory,
      collectSwap: schedulerConfig.collectSwap,
      collectDisk: schedulerConfig.collectDisk,
      collectLoad: schedulerConfig.collectLoad,
      collectFds: schedulerConfig.collectFds,
      collectTcp: schedulerConfig.collectTcp,
      collectProcesses: schedulerConfig.collectProcesses,
      collectTcpChecks: schedulerConfig.collectTcpChecks,
      collectCertChecks: schedulerConfig.collectCertChecks,
    };

    return {
      serverId: server.id,
      serverName: server.name,
      services: servicesConfig,
      metricsConfig,
    };
  });

  // Regenerate agent token and redeploy the agent
  fastify.post(
    '/api/servers/:id/regenerate-agent-token',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      // Only allow regeneration if agent mode is enabled
      if (server.metricsMode !== METRICS_MODE.AGENT) {
        return reply.code(400).send({ error: 'Server is not in agent mode' });
      }

      // Generate new token
      const newToken = crypto.randomBytes(32).toString('hex');

      await prisma.server.update({
        where: { id },
        data: { agentToken: newToken },
      });

      await logAudit({
        action: 'update',
        resourceType: 'server',
        resourceId: id,
        resourceName: server.name,
        details: { agentTokenRegenerated: true },
        userId: request.authUser!.id,
        environmentId: server.environmentId,
      });

      // Log token_regenerated event
      await logAgentEvent({
        serverId: id,
        eventType: 'token_regenerated',
        message: 'Agent token regenerated',
      });

      // Redeploy the agent with the new token so it keeps working
      const deployResult = await deployAgent(id);
      if (!deployResult.success) {
        return reply.code(500).send({
          error: `Token regenerated but agent redeploy failed: ${deployResult.error}`,
          tokenRegenerated: true,
        });
      }

      return { success: true };
    }
  );
}
