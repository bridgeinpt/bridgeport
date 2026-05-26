import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { checkServerHealth } from '../services/servers.js';
import { checkServiceHealth } from '../services/services.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { bundledAgentVersion } from '../lib/version.js';
import { getAgentEvents } from '../services/agent-events.js';
import { logHealthCheck } from '../services/health-checks.js';
import { SERVER_STATUS, HEALTH_STATUS, CONTAINER_STATUS, HEALTH_CHECK_STATUS, DISCOVERY_STATUS, type ServerStatus } from '../lib/constants.js';
import { validateBody, findOrNotFound, getErrorMessage } from '../lib/helpers.js';

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

// Shared error-response schemas for the columnar /metrics/history endpoints.
// fast-json-stringify needs every status code we emit declared so reply.send
// type-narrowing stays consistent with what we actually return.
const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: {},
  },
} as const;

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

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!env) return;

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
        success: groups.find((g) => g.status === HEALTH_CHECK_STATUS.SUCCESS)?._count ?? 0,
        failure: groups.find((g) => g.status === HEALTH_CHECK_STATUS.FAILURE)?._count ?? 0,
        timeout: groups.find((g) => g.status === HEALTH_CHECK_STATUS.TIMEOUT)?._count ?? 0,
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
      const body = validateBody(runHealthChecksSchema, request, reply);
      if (!body) return;

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!env) return;

      const results: {
        servers: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
        services: Array<{ id: string; name: string; status: string; durationMs: number; error?: string }>;
      } = { servers: [], services: [] };

      const { type } = body;

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
              status: result.status === SERVER_STATUS.HEALTHY ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
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
            const errorMessage = getErrorMessage(error, 'Unknown error');

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: HEALTH_CHECK_STATUS.FAILURE,
              durationMs,
              errorMessage,
            });

            results.servers.push({
              id: server.id,
              name: server.name,
              status: SERVER_STATUS.UNHEALTHY,
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
              status: isHealthy ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
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
            const errorMessage = getErrorMessage(error, 'Unknown error');

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'service',
              resourceId: service.id,
              resourceName: service.name,
              checkType: 'url',
              status: HEALTH_CHECK_STATUS.FAILURE,
              durationMs,
              errorMessage,
            });

            results.services.push({
              id: service.id,
              name: service.name,
              status: SERVER_STATUS.UNHEALTHY,
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
        ...actorFrom(request),
        environmentId: envId,
      });

      return { results };
    }
  );

  // Get metrics history for charts
  //
  // Columnar shape — issue #139. Instead of one nested per-server `data` array
  // (which stringifies to a lot of repeated property names and forces V8 to
  // allocate one object per point), we emit `timestamps[]` shared across all
  // servers and per-metric `series` arrays where each row aligns to the same
  // timestamp index. Sparse points become `null` so charts can distinguish
  // "no sample" from "value was zero".
  //
  // A Fastify response schema is attached so fast-json-stringify replaces the
  // generic JSON.stringify (any key not in the schema is dropped — which is
  // why every top-level + nested field is declared explicitly below).
  fastify.get(
    '/api/environments/:envId/metrics/history',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              servers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    tags: { type: ['string', 'null'] },
                  },
                },
              },
              timestamps: { type: 'array', items: { type: 'string' } },
              series: {
                type: 'object',
                properties: {
                  cpu: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  memory: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  memoryUsedMb: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  swap: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  swapUsedMb: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  disk: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  diskUsedGb: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  load1: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  load5: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  load15: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  openFds: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  maxFds: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  tcpEstablished: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  tcpListen: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  tcpTimeWait: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  tcpCloseWait: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  tcpTotal: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                },
              },
            },
          },
          400: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const query = metricsHistoryQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const { hours, metric } = query.data;
      const since = new Date();
      since.setHours(since.getHours() - hours);

      // Parallelize env existence check + servers load (no dependency).
      const [env, servers] = await Promise.all([
        prisma.environment.findUnique({ where: { id: envId }, select: { id: true } }),
        prisma.server.findMany({
          where: { environmentId: envId },
          select: { id: true, name: true, tags: true },
        }),
      ]);
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Fetch all metrics in one query, then bucket by serverId.
      // Sentry BRIDGEPORT-BE-2 was an N+1 here when this loop ran per-server.
      const serverIds = servers.map((s) => s.id);
      const rows =
        serverIds.length === 0
          ? []
          : await prisma.serverMetrics.findMany({
              where: {
                serverId: { in: serverIds },
                collectedAt: { gte: since },
              },
              orderBy: { collectedAt: 'asc' },
              select: {
                serverId: true,
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

      // Collect the union of timestamps across all servers so every series row
      // aligns to the same `timestamps[]` index.
      const timestampSet = new Set<string>();
      for (const row of rows) timestampSet.add(row.collectedAt.toISOString());
      const timestamps = Array.from(timestampSet).sort();
      const tsIndex = new Map<string, number>();
      timestamps.forEach((t, i) => tsIndex.set(t, i));

      // Bucket metric rows by server, then by timestamp index, so we can fill
      // per-server arrays of length `timestamps.length` with `null` for gaps.
      const byServer = new Map<string, typeof rows>();
      for (const id of serverIds) byServer.set(id, []);
      for (const row of rows) byServer.get(row.serverId)?.push(row);

      const T = timestamps.length;
      const newNullRow = (): Array<number | null> => new Array<number | null>(T).fill(null);

      // Which metric keys to emit. The `metric=` query param narrows the
      // response to a single key when set — fast-json-stringify will drop the
      // unused keys because they're absent from the assembled object.
      const allKeys = [
        'cpu',
        'memory',
        'memoryUsedMb',
        'swap',
        'swapUsedMb',
        'disk',
        'diskUsedGb',
        'load1',
        'load5',
        'load15',
        'openFds',
        'maxFds',
        'tcpEstablished',
        'tcpListen',
        'tcpTimeWait',
        'tcpCloseWait',
        'tcpTotal',
      ] as const;
      type SeriesKey = typeof allKeys[number];

      const keysToEmit: SeriesKey[] =
        metric === 'cpu'
          ? ['cpu']
          : metric === 'memory'
          ? ['memory', 'memoryUsedMb']
          : metric === 'disk'
          ? ['disk', 'diskUsedGb']
          : metric === 'load'
          ? ['load1', 'load5', 'load15']
          : [...allKeys];

      const series: Partial<Record<SeriesKey, Array<Array<number | null>>>> = {};
      for (const key of keysToEmit) series[key] = [];

      const serverMeta = servers.map((server) => {
        const metrics = byServer.get(server.id) ?? [];
        const rowByKey: Partial<Record<SeriesKey, Array<number | null>>> = {};
        for (const key of keysToEmit) rowByKey[key] = newNullRow();

        for (const m of metrics) {
          const ti = tsIndex.get(m.collectedAt.toISOString());
          if (ti === undefined) continue;

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

          // Only assign keys we're emitting (cheap branch per metric).
          if (rowByKey.cpu) rowByKey.cpu[ti] = m.cpuPercent;
          if (rowByKey.memory) rowByKey.memory[ti] = memPercent;
          if (rowByKey.memoryUsedMb) rowByKey.memoryUsedMb[ti] = m.memoryUsedMb;
          if (rowByKey.swap) rowByKey.swap[ti] = swapPercent;
          if (rowByKey.swapUsedMb) rowByKey.swapUsedMb[ti] = m.swapUsedMb;
          if (rowByKey.disk) rowByKey.disk[ti] = diskPercent;
          if (rowByKey.diskUsedGb) rowByKey.diskUsedGb[ti] = m.diskUsedGb;
          if (rowByKey.load1) rowByKey.load1[ti] = m.loadAvg1;
          if (rowByKey.load5) rowByKey.load5[ti] = m.loadAvg5;
          if (rowByKey.load15) rowByKey.load15[ti] = m.loadAvg15;
          if (rowByKey.openFds) rowByKey.openFds[ti] = m.openFds;
          if (rowByKey.maxFds) rowByKey.maxFds[ti] = m.maxFds;
          if (rowByKey.tcpEstablished) rowByKey.tcpEstablished[ti] = m.tcpEstablished;
          if (rowByKey.tcpListen) rowByKey.tcpListen[ti] = m.tcpListen;
          if (rowByKey.tcpTimeWait) rowByKey.tcpTimeWait[ti] = m.tcpTimeWait;
          if (rowByKey.tcpCloseWait) rowByKey.tcpCloseWait[ti] = m.tcpCloseWait;
          if (rowByKey.tcpTotal) rowByKey.tcpTotal[ti] = m.tcpTotal;
        }

        for (const key of keysToEmit) series[key]!.push(rowByKey[key]!);

        return { id: server.id, name: server.name, tags: server.tags };
      });

      return { servers: serverMeta, timestamps, series };
    }
  );

  // Get service metrics history for charts
  //
  // Columnar shape — see /metrics/history above for the rationale.
  fastify.get(
    '/api/environments/:envId/services/metrics/history',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              services: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    serverName: { type: 'string' },
                    serverId: { type: 'string' },
                  },
                },
              },
              timestamps: { type: 'array', items: { type: 'string' } },
              series: {
                type: 'object',
                properties: {
                  cpu: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  memory: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  memoryLimit: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  networkRx: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  networkTx: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                  restartCount: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
                },
              },
            },
          },
          400: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const query = metricsHistoryQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }

      const { hours } = query.data;
      const since = new Date();
      since.setHours(since.getHours() - hours);

      // Parallelize the env existence check with the server load. Service
      // load happens after because filtering services by `serverId IN [...]`
      // beats the `where: { server: { environmentId } }` EXISTS subquery
      // when N=services is large (avoids 90 correlated lookups into Server).
      const [env, envServers] = await Promise.all([
        prisma.environment.findUnique({ where: { id: envId }, select: { id: true } }),
        prisma.server.findMany({
          where: { environmentId: envId },
          select: { id: true, name: true },
        }),
      ]);
      if (!env) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const envServerIds = envServers.map((s) => s.id);
      const serverNameById = new Map(envServers.map((s) => [s.id, s.name]));

      const services = envServerIds.length === 0
        ? []
        : (await prisma.service.findMany({
            where: {
              serverId: { in: envServerIds },
              discoveryStatus: DISCOVERY_STATUS.FOUND,
            },
            select: { id: true, name: true, serverId: true },
          })).map((s) => ({
            id: s.id,
            name: s.name,
            server: { id: s.serverId, name: serverNameById.get(s.serverId) ?? '' },
          }));

      // Fetch all metrics in one query, then bucket by serviceId.
      // Sentry BRIDGEPORT-BE-5 was an N+1 here when this loop ran per-service.
      // We use $queryRaw to bypass Prisma's full row hydration — at 90
      // services × 12+ points = 1k+ rows per request, hydration is a real
      // cost we don't need to pay for chart data.
      const serviceIds = services.map((s) => s.id);
      interface MetricRow {
        serviceId: string;
        cpuPercent: number | null;
        memoryUsedMb: number | null;
        memoryLimitMb: number | null;
        networkRxMb: number | null;
        networkTxMb: number | null;
        restartCount: number | null;
        collectedAt: Date;
      }
      const rows: MetricRow[] =
        serviceIds.length === 0
          ? []
          : await prisma.$queryRaw<MetricRow[]>`
              SELECT "serviceId", "cpuPercent", "memoryUsedMb", "memoryLimitMb",
                     "networkRxMb", "networkTxMb", "restartCount", "collectedAt"
              FROM "ServiceMetrics"
              WHERE "serviceId" IN (${Prisma.join(serviceIds)})
                AND "collectedAt" >= ${since}
              ORDER BY "collectedAt" ASC
            `;

      // Union of all timestamps so every service row is the same length.
      const timestampSet = new Set<string>();
      for (const row of rows) {
        const iso = row.collectedAt instanceof Date
          ? row.collectedAt.toISOString()
          : new Date(row.collectedAt).toISOString();
        timestampSet.add(iso);
      }
      const timestamps = Array.from(timestampSet).sort();
      const tsIndex = new Map<string, number>();
      timestamps.forEach((t, i) => tsIndex.set(t, i));

      const byService = new Map<string, MetricRow[]>();
      for (const id of serviceIds) byService.set(id, []);
      for (const row of rows) byService.get(row.serviceId)?.push(row);

      const T = timestamps.length;
      const cpu: Array<Array<number | null>> = [];
      const memory: Array<Array<number | null>> = [];
      const memoryLimit: Array<Array<number | null>> = [];
      const networkRx: Array<Array<number | null>> = [];
      const networkTx: Array<Array<number | null>> = [];
      const restartCount: Array<Array<number | null>> = [];

      const serviceMeta = services.map((service) => {
        const metrics = byService.get(service.id) ?? [];
        const cpuRow = new Array<number | null>(T).fill(null);
        const memRow = new Array<number | null>(T).fill(null);
        const memLimitRow = new Array<number | null>(T).fill(null);
        const rxRow = new Array<number | null>(T).fill(null);
        const txRow = new Array<number | null>(T).fill(null);
        const restartRow = new Array<number | null>(T).fill(null);

        for (const m of metrics) {
          const iso = m.collectedAt instanceof Date
            ? m.collectedAt.toISOString()
            : new Date(m.collectedAt).toISOString();
          const ti = tsIndex.get(iso);
          if (ti === undefined) continue;
          cpuRow[ti] = m.cpuPercent;
          memRow[ti] = m.memoryUsedMb;
          memLimitRow[ti] = m.memoryLimitMb;
          rxRow[ti] = m.networkRxMb;
          txRow[ti] = m.networkTxMb;
          restartRow[ti] = m.restartCount;
        }

        cpu.push(cpuRow);
        memory.push(memRow);
        memoryLimit.push(memLimitRow);
        networkRx.push(rxRow);
        networkTx.push(txRow);
        restartCount.push(restartRow);

        return {
          id: service.id,
          name: service.name,
          serverName: service.server.name,
          serverId: service.server.id,
        };
      });

      return {
        services: serviceMeta,
        timestamps,
        series: { cpu, memory, memoryLimit, networkRx, networkTx, restartCount },
      };
    }
  );

  // Test SSH connection for a single server
  fastify.post(
    '/api/servers/:id/test-ssh',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await findOrNotFound(
        prisma.server.findUnique({
          where: { id },
          include: { environment: true },
        }),
        'Server',
        reply
      );
      if (!server) return;

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
          status: result.status === SERVER_STATUS.HEALTHY ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
          durationMs,
          errorMessage: result.error,
        });

        return {
          success: result.status === SERVER_STATUS.HEALTHY,
          durationMs,
          error: result.error,
        };
      } catch (error) {
        const durationMs = Date.now() - start;
        const errorMessage = getErrorMessage(error, 'Unknown error');

        await logHealthCheck({
          environmentId: server.environmentId,
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          checkType: 'ssh',
          status: HEALTH_CHECK_STATUS.FAILURE,
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

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!env) return;

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
              status: result.status === SERVER_STATUS.HEALTHY ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
              durationMs,
              errorMessage: result.error,
            });

            return {
              serverId: server.id,
              serverName: server.name,
              hostname: server.hostname,
              success: result.status === SERVER_STATUS.HEALTHY,
              durationMs,
              error: result.error,
            };
          } catch (error) {
            const durationMs = Date.now() - start;
            const errorMessage = getErrorMessage(error, 'Unknown error');

            await logHealthCheck({
              environmentId: envId,
              resourceType: 'server',
              resourceId: server.id,
              resourceName: server.name,
              checkType: 'ssh',
              status: HEALTH_CHECK_STATUS.FAILURE,
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

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!env) return;

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
      const healthyServers = servers.filter((s) => s.status === SERVER_STATUS.HEALTHY).length;
      const healthyServices = services.filter(
        (s) => s.containerStatus === CONTAINER_STATUS.RUNNING && s.healthStatus !== HEALTH_STATUS.UNHEALTHY
      ).length;

      // Count alerts (unhealthy resources)
      const unhealthyServers = servers.filter((s) => s.status === SERVER_STATUS.UNHEALTHY).length;
      const unhealthyServices = services.filter(
        (s) => s.healthStatus === HEALTH_STATUS.UNHEALTHY || s.containerStatus === CONTAINER_STATUS.EXITED || s.containerStatus === CONTAINER_STATUS.DEAD
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

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!env) return;

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

      // Pull the most-recent log per resource in two flat queries (one per
      // resourceType) and keep only the first occurrence per resourceId.
      // The `@@index([resourceId, createdAt desc])` on HealthCheckLog makes
      // the `ORDER BY createdAt DESC` cheap; the previous per-resource
      // findFirst loop was the N+1 driving p99 to ~200ms.
      const serverIds = servers.map((s) => s.id);
      const serviceIds = services.map((s) => s.id);
      const [serverLogs, serviceLogs] = await Promise.all([
        serverIds.length === 0
          ? Promise.resolve([] as Awaited<ReturnType<typeof prisma.healthCheckLog.findMany>>)
          : prisma.healthCheckLog.findMany({
              where: {
                environmentId: envId,
                resourceType: 'server',
                resourceId: { in: serverIds },
              },
              orderBy: { createdAt: 'desc' },
              select: {
                resourceId: true,
                createdAt: true,
                checkType: true,
                durationMs: true,
                status: true,
                errorMessage: true,
              },
            }),
        serviceIds.length === 0
          ? Promise.resolve([] as Awaited<ReturnType<typeof prisma.healthCheckLog.findMany>>)
          : prisma.healthCheckLog.findMany({
              where: {
                environmentId: envId,
                resourceType: 'service',
                resourceId: { in: serviceIds },
              },
              orderBy: { createdAt: 'desc' },
              select: {
                resourceId: true,
                createdAt: true,
                checkType: true,
                durationMs: true,
                status: true,
                errorMessage: true,
              },
            }),
      ]);

      const latestByResource = (rows: typeof serverLogs) => {
        const map = new Map<string, (typeof rows)[number]>();
        for (const r of rows) if (!map.has(r.resourceId)) map.set(r.resourceId, r);
        return map;
      };
      const latestServerLog = latestByResource(serverLogs);
      const latestServiceLog = latestByResource(serviceLogs);

      const toLastCheck = (
        log: (typeof serverLogs)[number] | undefined
      ) =>
        log
          ? {
              timestamp: log.createdAt.toISOString(),
              checkType: log.checkType,
              durationMs: log.durationMs,
              errorMessage: log.errorMessage,
            }
          : null;
      const toStatus = (log: (typeof serverLogs)[number] | undefined): ServerStatus => {
        if (!log) return SERVER_STATUS.UNKNOWN;
        return log.status === HEALTH_CHECK_STATUS.SUCCESS
          ? SERVER_STATUS.HEALTHY
          : SERVER_STATUS.UNHEALTHY;
      };

      const serverHealthStatus = servers.map((server) => {
        const log = latestServerLog.get(server.id);
        return {
          id: server.id,
          name: server.name,
          type: 'server' as const,
          status: toStatus(log),
          lastCheck: toLastCheck(log),
        };
      });

      const serviceHealthStatus = services.map((service) => {
        const log = latestServiceLog.get(service.id);
        return {
          id: service.id,
          name: service.name,
          type: 'service' as const,
          status: toStatus(log),
          serverName: service.server.name,
          lastCheck: toLastCheck(log),
        };
      });

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
        let status: ServerStatus = SERVER_STATUS.UNKNOWN;
        if (db.monitoringStatus === 'connected') {
          status = SERVER_STATUS.HEALTHY;
        } else if (db.monitoringStatus === 'error') {
          status = SERVER_STATUS.UNHEALTHY;
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

      const env = await findOrNotFound(
        prisma.environment.findUnique({
          where: { id: envId },
          select: { id: true },
        }),
        'Environment',
        reply
      );
      if (!env) return;

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

      const server = await findOrNotFound(prisma.server.findUnique({ where: { id } }), 'Server', reply);
      if (!server) return;

      const events = await getAgentEvents(id, limit ? parseInt(limit, 10) : 20);

      return { events };
    }
  );
}
