import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { checkServerHealth } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { logAudit } from '../services/audit.js';
import { bundledAgentVersion } from '../server.js';
import { getAgentEvents } from '../services/agent-events.js';

const healthLogQuerySchema = z.object({
  type: z.enum(['server', 'service', 'container']).optional(),
  checkType: z.enum(['ssh', 'url', 'container_health', 'discovery']).optional(),
  status: z.enum(['success', 'failure', 'timeout']).optional(),
  resourceId: z.string().optional(),
  hours: z.coerce.number().min(1).max(168).default(24), // Max 7 days
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
});

const metricsHistoryQuerySchema = z.object({
  hours: z.coerce.number().min(1).max(168).default(24),
  metric: z.enum(['cpu', 'memory', 'disk', 'load']).optional(),
});

const runHealthChecksSchema = z.object({
  type: z.enum(['all', 'servers', 'services']).optional().default('all'),
});

const schedulerConfigSchema = z.object({
  serverHealthIntervalMs: z.number().min(10000).max(3600000).optional(),
  serviceHealthIntervalMs: z.number().min(10000).max(3600000).optional(),
  discoveryIntervalMs: z.number().min(60000).max(86400000).optional(),
  metricsIntervalMs: z.number().min(60000).max(3600000).optional(),
  updateCheckIntervalMs: z.number().min(60000).max(86400000).optional(),
  backupCheckIntervalMs: z.number().min(10000).max(3600000).optional(),
  metricsRetentionDays: z.number().min(1).max(365).optional(),
  healthLogRetentionDays: z.number().min(1).max(365).optional(),
  bounceThreshold: z.number().min(1).max(10).optional(),
  bounceCooldownMs: z.number().min(60000).max(86400000).optional(),
  // Metrics collection toggles
  collectCpu: z.boolean().optional(),
  collectMemory: z.boolean().optional(),
  collectSwap: z.boolean().optional(),
  collectDisk: z.boolean().optional(),
  collectLoad: z.boolean().optional(),
  collectFds: z.boolean().optional(),
  collectTcp: z.boolean().optional(),
  collectProcesses: z.boolean().optional(),
  collectTcpChecks: z.boolean().optional(),
  collectCertChecks: z.boolean().optional(),
});

// Default scheduler config values
const DEFAULT_SCHEDULER_CONFIG = {
  serverHealthIntervalMs: 60000,
  serviceHealthIntervalMs: 60000,
  discoveryIntervalMs: 300000,
  metricsIntervalMs: 300000,
  updateCheckIntervalMs: 1800000,
  backupCheckIntervalMs: 60000,
  metricsRetentionDays: 7,
  healthLogRetentionDays: 30,
  bounceThreshold: 3,
  bounceCooldownMs: 900000,
  // Metrics collection toggles - all enabled by default
  collectCpu: true,
  collectMemory: true,
  collectSwap: true,
  collectDisk: true,
  collectLoad: true,
  collectFds: true,
  collectTcp: true,
  collectProcesses: true,
  collectTcpChecks: true,
  collectCertChecks: true,
};

export type SchedulerConfig = typeof DEFAULT_SCHEDULER_CONFIG;

/**
 * Log a health check result
 */
export async function logHealthCheck(params: {
  environmentId: string;
  resourceType: 'server' | 'service' | 'container';
  resourceId: string;
  resourceName: string;
  checkType: 'ssh' | 'url' | 'container_health' | 'discovery';
  status: 'success' | 'failure' | 'timeout';
  durationMs?: number;
  httpStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  await prisma.healthCheckLog.create({
    data: params,
  });
}

/**
 * Clean up old health check logs based on retention days
 */
export async function cleanupHealthCheckLogs(retentionDays: number): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const result = await prisma.healthCheckLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
    },
  });

  return result.count;
}

/**
 * Get scheduler config for an environment (with defaults filled in)
 */
export async function getSchedulerConfig(environmentId: string): Promise<SchedulerConfig> {
  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { schedulerConfig: true },
  });

  const stored = env?.schedulerConfig ? JSON.parse(env.schedulerConfig) : {};
  return { ...DEFAULT_SCHEDULER_CONFIG, ...stored };
}

export async function monitoringRoutes(fastify: FastifyInstance): Promise<void> {
  // Get health check logs with filtering and pagination
  fastify.get(
    '/api/environments/:envId/health-logs',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const query = healthLogQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const { type, checkType, status, resourceId, hours, page, limit } = query.data;
      const since = new Date();
      since.setHours(since.getHours() - hours);

      const where = {
        environmentId: envId,
        createdAt: { gte: since },
        ...(type && { resourceType: type }),
        ...(checkType && { checkType }),
        ...(status && { status }),
        ...(resourceId && { resourceId }),
      };

      const [logs, total] = await Promise.all([
        prisma.healthCheckLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.healthCheckLog.count({ where }),
      ]);

      // Get summary counts
      const summaryWhere = {
        environmentId: envId,
        createdAt: { gte: since },
      };

      const [serverChecks, serviceChecks, containerChecks] = await Promise.all([
        prisma.healthCheckLog.groupBy({
          by: ['status'],
          where: { ...summaryWhere, resourceType: 'server' },
          _count: true,
        }),
        prisma.healthCheckLog.groupBy({
          by: ['status'],
          where: { ...summaryWhere, resourceType: 'service' },
          _count: true,
        }),
        prisma.healthCheckLog.groupBy({
          by: ['status'],
          where: { ...summaryWhere, resourceType: 'container' },
          _count: true,
        }),
      ]);

      const summarize = (groups: Array<{ status: string; _count: number }>) => ({
        success: groups.find((g) => g.status === 'success')?._count ?? 0,
        failure: groups.find((g) => g.status === 'failure')?._count ?? 0,
        timeout: groups.find((g) => g.status === 'timeout')?._count ?? 0,
      });

      return {
        logs,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        summary: {
          server: summarize(serverChecks),
          service: summarize(serviceChecks),
          container: summarize(containerChecks),
        },
      };
    }
  );

  // Trigger immediate health checks
  fastify.post(
    '/api/environments/:envId/health-checks/run',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = runHealthChecksSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const results: {
        servers: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
        services: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
      } = { servers: [], services: [] };

      const { type } = body.data;

      // Run server health checks
      if (type === 'all' || type === 'servers') {
        const servers = await prisma.server.findMany({
          where: { environmentId: envId },
          select: { id: true, name: true },
        });

        for (const server of servers) {
          const start = Date.now();
          try {
            const result = await checkServerHealth(server.id);
            const durationMs = Date.now() - start;

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: result.status === 'healthy' ? 'success' : 'failure',
              durationMs,
              errorMessage: result.error,
            });

            results.servers.push({
              id: server.id,
              name: server.name,
              status: result.status,
              durationMs,
              error: result.error,
            });
          } catch (error) {
            const durationMs = Date.now() - start;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: 'failure',
              durationMs,
              errorMessage,
            });

            results.servers.push({
              id: server.id,
              name: server.name,
              status: 'unhealthy',
              durationMs,
              error: errorMessage,
            });
          }
        }
      }

      // Run service health checks
      if (type === 'all' || type === 'services') {
        const services = await prisma.service.findMany({
          where: {
            server: { environmentId: envId },
            healthCheckUrl: { not: null },
          },
          select: { id: true, name: true, healthCheckUrl: true },
        });

        for (const service of services) {
          const start = Date.now();
          try {
            const result = await checkServiceHealth(service.id);
            const durationMs = Date.now() - start;

            // Determine overall health status
            const isHealthy = result.container.running && (result.url === null || result.url.success);

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'service',
              resourceId: service.id,
              resourceName: service.name,
              checkType: result.url ? 'url' : 'container_health',
              status: isHealthy ? 'success' : 'failure',
              durationMs,
              httpStatus: result.url?.statusCode,
              errorMessage: result.url?.error,
            });

            results.services.push({
              id: service.id,
              name: service.name,
              status: result.status,
              durationMs,
              error: result.url?.error,
            });
          } catch (error) {
            const durationMs = Date.now() - start;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'service',
              resourceId: service.id,
              resourceName: service.name,
              checkType: 'url',
              status: 'failure',
              durationMs,
              errorMessage,
            });

            results.services.push({
              id: service.id,
              name: service.name,
              status: 'unhealthy',
              durationMs,
              error: errorMessage,
            });
          }
        }
      }

      await logAudit({
        action: 'health_check',
        resourceType: 'environment',
        resourceId: envId,
        resourceName: env.name,
        details: {
          type,
          serverCount: results.servers.length,
          serviceCount: results.services.length,
        },
        userId: request.authUser!.id,
        environmentId: envId,
      });

      return { results };
    }
  );

  // Get metrics history for charts
  fastify.get(
    '/api/environments/:envId/metrics/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const query = metricsHistoryQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const { hours, metric } = query.data;
      const since = new Date();
      since.setHours(since.getHours() - hours);

      // Get servers in this environment
      const servers = await prisma.server.findMany({
        where: { environmentId: envId },
        select: { id: true, name: true, tags: true },
      });

      // Get metrics for each server
      const serverMetrics = await Promise.all(
        servers.map(async (server) => {
          const metrics = await prisma.serverMetrics.findMany({
            where: {
              serverId: server.id,
              collectedAt: { gte: since },
            },
            orderBy: { collectedAt: 'asc' },
            select: {
              cpuPercent: true,
              memoryUsedMb: true,
              memoryTotalMb: true,
              swapUsedMb: true,
              swapTotalMb: true,
              diskUsedGb: true,
              diskTotalGb: true,
              loadAvg1: true,
              loadAvg5: true,
              loadAvg15: true,
              openFds: true,
              maxFds: true,
              tcpEstablished: true,
              tcpListen: true,
              tcpTimeWait: true,
              tcpCloseWait: true,
              tcpTotal: true,
              collectedAt: true,
            },
          });

          // Transform metrics based on requested metric type
          const data = metrics.map((m) => {
            const base = { time: m.collectedAt.toISOString() };

            // If no specific metric requested, return all metrics
            if (!metric) {
              const memPercent =
                m.memoryUsedMb && m.memoryTotalMb
                  ? (m.memoryUsedMb / m.memoryTotalMb) * 100
                  : null;
              const swapPercent =
                m.swapUsedMb && m.swapTotalMb && m.swapTotalMb > 0
                  ? (m.swapUsedMb / m.swapTotalMb) * 100
                  : null;
              const diskPercent =
                m.diskUsedGb && m.diskTotalGb ? (m.diskUsedGb / m.diskTotalGb) * 100 : null;
              return {
                ...base,
                cpu: m.cpuPercent,
                memory: memPercent,
                memoryUsedMb: m.memoryUsedMb,
                swap: swapPercent,
                swapUsedMb: m.swapUsedMb,
                disk: diskPercent,
                diskUsedGb: m.diskUsedGb,
                load1: m.loadAvg1,
                load5: m.loadAvg5,
                load15: m.loadAvg15,
                openFds: m.openFds,
                maxFds: m.maxFds,
                tcpEstablished: m.tcpEstablished,
                tcpListen: m.tcpListen,
                tcpTimeWait: m.tcpTimeWait,
                tcpCloseWait: m.tcpCloseWait,
                tcpTotal: m.tcpTotal,
              };
            }
            if (metric === 'cpu') {
              return { ...base, cpu: m.cpuPercent };
            }
            if (metric === 'memory') {
              const memPercent =
                m.memoryUsedMb && m.memoryTotalMb
                  ? (m.memoryUsedMb / m.memoryTotalMb) * 100
                  : null;
              return { ...base, memory: memPercent, memoryUsedMb: m.memoryUsedMb };
            }
            if (metric === 'disk') {
              const diskPercent =
                m.diskUsedGb && m.diskTotalGb ? (m.diskUsedGb / m.diskTotalGb) * 100 : null;
              return { ...base, disk: diskPercent, diskUsedGb: m.diskUsedGb };
            }
            if (metric === 'load') {
              return { ...base, load1: m.loadAvg1, load5: m.loadAvg5, load15: m.loadAvg15 };
            }
            return base;
          });

          return {
            id: server.id,
            name: server.name,
            tags: server.tags,
            data,
          };
        })
      );

      return { servers: serverMetrics };
    }
  );

  // Test SSH connection for a single server
  fastify.post(
    '/api/servers/:id/test-ssh',
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

      const start = Date.now();
      try {
        const result = await checkServerHealth(id);
        const durationMs = Date.now() - start;

        await logHealthCheck({
          environmentId: server.environmentId,
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          checkType: 'ssh',
          status: result.status === 'healthy' ? 'success' : 'failure',
          durationMs,
          errorMessage: result.error,
        });

        return {
          success: result.status === 'healthy',
          durationMs,
          error: result.error,
        };
      } catch (error) {
        const durationMs = Date.now() - start;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        await logHealthCheck({
          environmentId: server.environmentId,
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          checkType: 'ssh',
          status: 'failure',
          durationMs,
          errorMessage,
        });

        return {
          success: false,
          durationMs,
          error: errorMessage,
        };
      }
    }
  );

  // Test SSH connections for all servers in an environment
  fastify.post(
    '/api/environments/:envId/test-all-ssh',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const servers = await prisma.server.findMany({
        where: { environmentId: envId },
        select: { id: true, name: true, hostname: true },
      });

      // Test all servers in parallel
      const results = await Promise.all(
        servers.map(async (server) => {
          const start = Date.now();
          try {
            const result = await checkServerHealth(server.id);
            const durationMs = Date.now() - start;

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: result.status === 'healthy' ? 'success' : 'failure',
              durationMs,
              errorMessage: result.error,
            });

            return {
              serverId: server.id,
              serverName: server.name,
              hostname: server.hostname,
              success: result.status === 'healthy',
              durationMs,
              error: result.error,
            };
          } catch (error) {
            const durationMs = Date.now() - start;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: 'failure',
              durationMs,
              errorMessage,
            });

            return {
              serverId: server.id,
              serverName: server.name,
              hostname: server.hostname,
              success: false,
              durationMs,
              error: errorMessage,
            };
          }
        })
      );

      return { results };
    }
  );

  // Get scheduler config for environment
  fastify.get(
    '/api/environments/:envId/scheduler-config',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const config = await getSchedulerConfig(envId);
      return { config };
    }
  );

  // Update scheduler config for environment
  fastify.patch(
    '/api/environments/:envId/scheduler-config',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = schedulerConfigSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid config', details: body.error.issues });
      }

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Merge with existing config
      const existingConfig = env.schedulerConfig ? JSON.parse(env.schedulerConfig) : {};
      const newConfig = { ...existingConfig, ...body.data };

      await prisma.environment.update({
        where: { id: envId },
        data: { schedulerConfig: JSON.stringify(newConfig) },
      });

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: envId,
        resourceName: env.name,
        details: { schedulerConfigUpdated: body.data },
        userId: request.authUser!.id,
        environmentId: envId,
      });

      const fullConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...newConfig };
      return { config: fullConfig };
    }
  );

  // Get monitoring overview stats
  fastify.get(
    '/api/environments/:envId/monitoring/overview',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Get server stats
      const servers = await prisma.server.findMany({
        where: { environmentId: envId },
        select: { id: true, status: true },
      });

      // Get service stats
      const services = await prisma.service.findMany({
        where: { server: { environmentId: envId } },
        select: { id: true, status: true, healthStatus: true, containerStatus: true },
      });

      // Count healthy resources
      const healthyServers = servers.filter((s) => s.status === 'healthy').length;
      const healthyServices = services.filter(
        (s) => s.containerStatus === 'running' && s.healthStatus !== 'unhealthy'
      ).length;

      // Count alerts (unhealthy resources)
      const unhealthyServers = servers.filter((s) => s.status === 'unhealthy').length;
      const unhealthyServices = services.filter(
        (s) => s.healthStatus === 'unhealthy' || s.containerStatus === 'exited' || s.containerStatus === 'dead'
      ).length;

      return {
        stats: {
          servers: {
            total: servers.length,
            healthy: healthyServers,
            unhealthy: unhealthyServers,
          },
          services: {
            total: services.length,
            healthy: healthyServices,
            unhealthy: unhealthyServices,
          },
          alerts: unhealthyServers + unhealthyServices,
        },
      };
    }
  );

  // Get agents/SSH status for all servers
  fastify.get(
    '/api/environments/:envId/agents',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({
        where: { id: envId },
        select: { id: true, sshUser: true },
      });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const servers = await prisma.server.findMany({
        where: { environmentId: envId },
        select: {
          id: true,
          name: true,
          hostname: true,
          status: true,
          metricsMode: true,
          agentToken: true,
          agentStatus: true,
          agentVersion: true,
          agentStatusChangedAt: true,
          lastCheckedAt: true,
          lastAgentPushAt: true,
          metrics: {
            orderBy: { collectedAt: 'desc' },
            take: 1,
            select: { collectedAt: true, source: true },
          },
        },
      });

      const agentsInfo = servers.map((server) => ({
        id: server.id,
        name: server.name,
        hostname: server.hostname,
        sshStatus: server.status,
        metricsMode: server.metricsMode,
        hasAgentToken: !!server.agentToken,
        agentStatus: server.agentStatus,
        agentVersion: server.agentVersion,
        agentStatusChangedAt: server.agentStatusChangedAt,
        lastCheckedAt: server.lastCheckedAt,
        lastAgentPushAt: server.lastAgentPushAt,
        lastMetricsPush: server.metrics[0]?.collectedAt || null,
        metricsSource: server.metrics[0]?.source || null,
      }));

      return {
        sshUser: env.sshUser,
        agents: agentsInfo,
        bundledAgentVersion,
      };
    }
  );

  // Get agent events for a server
  fastify.get(
    '/api/servers/:id/agent-events',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const events = await getAgentEvents(id, limit ? parseInt(limit, 10) : 20);

      return { events };
    }
  );
}
