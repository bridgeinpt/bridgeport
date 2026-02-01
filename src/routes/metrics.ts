import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  collectServerMetricsSSH,
  collectServiceMetrics,
  saveServerMetrics,
  saveServiceMetrics,
  getServerMetrics,
  getServiceMetrics,
  getEnvironmentMetricsSummary,
} from '../services/metrics.js';
import { logAudit } from '../services/audit.js';
import crypto from 'crypto';

const metricsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).optional(),
});

const serverMetricsIngestSchema = z.object({
  cpuPercent: z.number().optional(),
  memoryUsedMb: z.number().optional(),
  memoryTotalMb: z.number().optional(),
  diskUsedGb: z.number().optional(),
  diskTotalGb: z.number().optional(),
  loadAvg1: z.number().optional(),
  loadAvg5: z.number().optional(),
  loadAvg15: z.number().optional(),
  uptime: z.number().optional(),
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
      })
    )
    .optional(),
});

const updateMetricsModeSchema = z.object({
  metricsMode: z.enum(['ssh', 'agent', 'disabled']),
});

export async function metricsRoutes(fastify: FastifyInstance) {
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

      if (server.metricsMode === 'disabled') {
        return reply.code(400).send({ error: 'Metrics collection is disabled for this server' });
      }

      if (server.metricsMode === 'agent') {
        return reply.code(400).send({ error: 'This server uses agent mode. Wait for agent to push metrics.' });
      }

      // Collect server metrics
      const serverMetrics = await collectServerMetricsSSH(id);
      if (serverMetrics) {
        await saveServerMetrics(id, serverMetrics, 'ssh');
      }

      // Collect service metrics
      const serviceResults: Array<{ service: string; success: boolean }> = [];
      for (const service of server.services) {
        const serviceMetrics = await collectServiceMetrics(id, service.containerName);
        if (serviceMetrics) {
          await saveServiceMetrics(service.id, serviceMetrics);
          serviceResults.push({ service: service.name, success: true });
        } else {
          serviceResults.push({ service: service.name, success: false });
        }
      }

      return {
        serverMetrics: serverMetrics ? 'collected' : 'failed',
        services: serviceResults,
      };
    }
  );

  // Update server metrics mode
  fastify.patch(
    '/api/servers/:id/metrics-mode',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateMetricsModeSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const updateData: { metricsMode: string; agentToken?: string } = {
        metricsMode: body.data.metricsMode,
      };

      // Generate agent token if switching to agent mode
      if (body.data.metricsMode === 'agent' && !server.agentToken) {
        updateData.agentToken = crypto.randomBytes(32).toString('hex');
      }

      const updated = await prisma.server.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          metricsMode: true,
          agentToken: true,
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'server',
        resourceId: id,
        resourceName: server.name,
        details: { metricsMode: body.data.metricsMode },
        userId: request.authUser!.id,
        environmentId: server.environmentId,
      });

      return {
        server: {
          id: updated.id,
          name: updated.name,
          metricsMode: updated.metricsMode,
          agentToken: updated.metricsMode === 'agent' ? updated.agentToken : undefined,
        },
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
      where: { agentToken: token, metricsMode: 'agent' },
      include: { services: true },
    });

    if (!server) {
      return reply.code(401).send({ error: 'Invalid agent token' });
    }

    const body = serverMetricsIngestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid metrics data', details: body.error.issues });
    }

    // Save server metrics
    const { services: serviceMetrics, ...serverMetricsData } = body.data;
    await saveServerMetrics(server.id, serverMetricsData, 'agent');

    // Save service metrics if provided
    if (serviceMetrics && serviceMetrics.length > 0) {
      for (const sm of serviceMetrics) {
        const service = server.services.find((s) => s.containerName === sm.containerName);
        if (service) {
          const { containerName, ...metricsData } = sm;
          await saveServiceMetrics(service.id, metricsData);
        }
      }
    }

    return { success: true };
  });

  // Regenerate agent token
  fastify.post(
    '/api/servers/:id/regenerate-agent-token',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const server = await prisma.server.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

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

      return { agentToken: newToken };
    }
  );
}
