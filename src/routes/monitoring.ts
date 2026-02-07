import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { checkServerHealth } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { logAudit } from '../services/audit.js';
import { bundledAgentVersion } from '../server.js';
import { getAgentEvents } from '../services/agent-events.js';
import { logHealthCheck } from '../services/health-checks.js';

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

  // Get service metrics history for charts
  fastify.get(
    '/api/environments/:envId/services/metrics/history',
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

      const { hours } = query.data;
      const since = new Date();
      since.setHours(since.getHours() - hours);

      // Get services in this environment with their servers
      const services = await prisma.service.findMany({
        where: {
          server: { environmentId: envId },
          discoveryStatus: 'found',
        },
        select: { id: true, name: true, server: { select: { id: true, name: true } } },
      });

      // Get metrics for each service
      const serviceMetrics = await Promise.all(
        services.map(async (service) => {
          const metrics = await prisma.serviceMetrics.findMany({
            where: {
              serviceId: service.id,
              collectedAt: { gte: since },
            },
            orderBy: { collectedAt: 'asc' },
            select: {
              cpuPercent: true,
              memoryUsedMb: true,
              memoryLimitMb: true,
              networkRxMb: true,
              networkTxMb: true,
              restartCount: true,
              collectedAt: true,
            },
          });

          const data = metrics.map((m) => ({
            time: m.collectedAt.toISOString(),
            cpu: m.cpuPercent,
            memory: m.memoryUsedMb,
            memoryLimit: m.memoryLimitMb,
            networkRx: m.networkRxMb,
            networkTx: m.networkTxMb,
            restartCount: m.restartCount,
          }));

          return {
            id: service.id,
            name: service.name,
            serverName: service.server.name,
            serverId: service.server.id,
            data,
          };
        })
      );

      return { services: serviceMetrics };
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

      // Get database monitoring stats
      const databases = await prisma.database.findMany({
        where: { environmentId: envId },
        select: { monitoringEnabled: true, monitoringStatus: true },
      });

      const monitoredDatabases = databases.filter(d => d.monitoringEnabled);
      const connectedDatabases = monitoredDatabases.filter(d => d.monitoringStatus === 'connected').length;
      const errorDatabases = monitoredDatabases.filter(d => d.monitoringStatus === 'error').length;

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
          databases: {
            total: databases.length,
            monitored: monitoredDatabases.length,
            connected: connectedDatabases,
            error: errorDatabases,
          },
          alerts: unhealthyServers + unhealthyServices + errorDatabases,
        },
      };
    }
  );

  // Get current health status of all servers and services
  fastify.get(
    '/api/environments/:envId/health-status',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      const env = await prisma.environment.findUnique({ where: { id: envId } });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Get all servers in this environment
      const servers = await prisma.server.findMany({
        where: { environmentId: envId },
        select: { id: true, name: true },
      });

      // Get all services in this environment
      const services = await prisma.service.findMany({
        where: { server: { environmentId: envId } },
        select: {
          id: true,
          name: true,
          server: { select: { id: true, name: true } },
        },
      });

      // Get most recent health check log for each server
      const serverHealthStatus = await Promise.all(
        servers.map(async (server) => {
          const lastLog = await prisma.healthCheckLog.findFirst({
            where: {
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
            },
            orderBy: { createdAt: 'desc' },
            select: {
              createdAt: true,
              checkType: true,
              durationMs: true,
              status: true,
              errorMessage: true,
            },
          });

          let status: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
          if (lastLog) {
            status = lastLog.status === 'success' ? 'healthy' : 'unhealthy';
          }

          return {
            id: server.id,
            name: server.name,
            type: 'server' as const,
            status,
            lastCheck: lastLog
              ? {
                  timestamp: lastLog.createdAt.toISOString(),
                  checkType: lastLog.checkType,
                  durationMs: lastLog.durationMs,
                  errorMessage: lastLog.errorMessage,
                }
              : null,
          };
        })
      );

      // Get most recent health check log for each service
      const serviceHealthStatus = await Promise.all(
        services.map(async (service) => {
          const lastLog = await prisma.healthCheckLog.findFirst({
            where: {
              environmentId: envId,
              resourceType: 'service',
              resourceId: service.id,
            },
            orderBy: { createdAt: 'desc' },
            select: {
              createdAt: true,
              checkType: true,
              durationMs: true,
              status: true,
              errorMessage: true,
            },
          });

          let status: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
          if (lastLog) {
            status = lastLog.status === 'success' ? 'healthy' : 'unhealthy';
          }

          return {
            id: service.id,
            name: service.name,
            type: 'service' as const,
            status,
            serverName: service.server.name,
            lastCheck: lastLog
              ? {
                  timestamp: lastLog.createdAt.toISOString(),
                  checkType: lastLog.checkType,
                  durationMs: lastLog.durationMs,
                  errorMessage: lastLog.errorMessage,
                }
              : null,
          };
        })
      );

      // Get all monitored databases in this environment
      const databases = await prisma.database.findMany({
        where: { environmentId: envId, monitoringEnabled: true },
        select: {
          id: true,
          name: true,
          type: true,
          monitoringStatus: true,
          lastCollectedAt: true,
          lastMonitoringError: true,
          server: { select: { name: true } },
          databaseType: { select: { displayName: true } },
        },
      });

      const databaseHealthStatus = databases.map((db) => {
        let status: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
        if (db.monitoringStatus === 'connected') {
          status = 'healthy';
        } else if (db.monitoringStatus === 'error') {
          status = 'unhealthy';
        }

        return {
          id: db.id,
          name: db.name,
          type: 'database' as const,
          status,
          serverName: db.server?.name || null,
          dbType: db.databaseType?.displayName || db.type,
          lastCheck: db.lastCollectedAt
            ? {
                timestamp: db.lastCollectedAt.toISOString(),
                checkType: 'monitoring',
                durationMs: null as number | null,
                errorMessage: db.lastMonitoringError,
              }
            : null,
        };
      });

      return {
        servers: serverHealthStatus,
        services: serviceHealthStatus,
        databases: databaseHealthStatus,
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
        select: { id: true },
      });
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const generalSettings = await prisma.generalSettings.findUnique({
        where: { environmentId: envId },
      });

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
        sshUser: generalSettings?.sshUser ?? 'root',
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
