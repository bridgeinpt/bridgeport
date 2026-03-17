import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import {
  deployService,
  getDeploymentHistory,
  getDeployment,
  getContainerLogs,
  getLatestImageTags,
} from '../services/deploy.js';
import { DockerSSH, createClientForServer } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { logAudit } from '../services/audit.js';
import { logHealthCheck } from '../services/health-checks.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { determineHealthStatus, determineOverallStatus } from '../services/servers.js';
import { getSystemSettings } from '../services/system-settings.js';
import { HEALTH_STATUS, CONTAINER_STATUS, DISCOVERY_STATUS, HEALTH_CHECK_STATUS } from '../lib/constants.js';

const createServiceSchema = z.object({
  name: z.string().min(1),
  containerName: z.string().min(1),
  containerImageId: z.string().min(1),  // Required - links to ContainerImage
  imageTag: z.string().default('latest'),
  composePath: z.string().optional(),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  containerName: z.string().min(1).optional(),
  containerImageId: z.string().min(1).optional(),  // Can change container image
  imageTag: z.string().optional(),
  composePath: z.string().nullable().optional(),
  healthCheckUrl: z.string().nullable().optional(),
  serviceTypeId: z.string().nullable().optional(),
  // Health check configuration for deployment orchestration
  healthWaitMs: z.number().int().min(0).optional(),
  healthRetries: z.number().int().min(1).optional(),
  healthIntervalMs: z.number().int().min(0).optional(),
});

const runCommandSchema = z.object({
  commandName: z.string().min(1),
});

const deploySchema = z.object({
  imageTag: z.string().optional(),
  generateArtifacts: z.boolean().default(true),
  pullImage: z.boolean().default(true),
});

export async function serviceRoutes(fastify: FastifyInstance): Promise<void> {
  // List services for server
  fastify.get(
    '/api/servers/:serverId/services',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { serverId } = request.params as { serverId: string };

      const services = await prisma.service.findMany({
        where: { serverId },
        orderBy: { name: 'asc' },
      });

      return { services };
    }
  );

  // List services for environment (paginated)
  fastify.get(
    '/api/environments/:envId/services',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit: limitStr, offset: offsetStr } = request.query as { limit?: string; offset?: string };
      const limit = limitStr ? parseInt(limitStr) : 25;
      const offset = offsetStr ? parseInt(offsetStr) : 0;

      const where = { server: { environmentId: envId } };

      const [services, total] = await Promise.all([
        prisma.service.findMany({
          where,
          include: {
            containerImage: true,
            serviceType: true,
            server: { select: { id: true, name: true } },
          },
          orderBy: { name: 'asc' },
          take: limit,
          skip: offset,
        }),
        prisma.service.count({ where }),
      ]);

      return { services, total };
    }
  );

  // Get service
  fastify.get(
    '/api/services/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: {
          server: {
            include: { environment: true },
          },
          serviceType: {
            include: {
              commands: {
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
          containerImage: {
            include: {
              registryConnection: true,
            },
          },
        },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      return { service };
    }
  );

  // Create service
  fastify.post(
    '/api/servers/:serverId/services',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };
      const body = createServiceSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const server = await prisma.server.findUnique({ where: { id: serverId } });

        // Verify containerImage exists and is in the same environment
        const containerImage = await prisma.containerImage.findUnique({
          where: { id: body.data.containerImageId },
        });
        if (!containerImage) {
          return reply.code(400).send({ error: 'Container image not found' });
        }
        if (containerImage.environmentId !== server?.environmentId) {
          return reply.code(400).send({ error: 'Container image must be in the same environment' });
        }

        const service = await prisma.service.create({
          data: {
            ...body.data,
            serverId,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: { containerName: service.containerName, containerImageId: service.containerImageId },
          userId: request.authUser!.id,
          environmentId: server?.environmentId,
        });

        return { service };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Service already exists' });
        }
        throw error;
      }
    }
  );

  // Update service
  fastify.patch(
    '/api/services/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateServiceSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.service.findUnique({
          where: { id },
          include: { server: true },
        });
        const service = await prisma.service.update({
          where: { id },
          data: body.data,
        });

        await logAudit({
          action: 'update',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: { changes: body.data },
          userId: request.authUser!.id,
          environmentId: existing?.server.environmentId,
        });

        return { service };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Service not found' });
        }
        throw error;
      }
    }
  );

  // Delete service
  fastify.delete(
    '/api/services/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const service = await prisma.service.findUnique({
          where: { id },
          include: { server: true },
        });
        await prisma.service.delete({ where: { id } });

        if (service) {
          await logAudit({
            action: 'delete',
            resourceType: 'service',
            resourceId: id,
            resourceName: service.name,
            userId: request.authUser!.id,
            environmentId: service.server.environmentId,
          });
        }

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Service not found' });
        }
        throw error;
      }
    }
  );

  // Deploy service
  fastify.post(
    '/api/services/:id/deploy',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deploySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true },
      });

      try {
        const result = await deployService(
          id,
          request.authUser!.email,
          request.authUser!.id,
          body.data
        );

        await logAudit({
          action: 'deploy',
          resourceType: 'service',
          resourceId: id,
          resourceName: service?.name,
          details: { imageTag: body.data.imageTag || service?.imageTag, deploymentId: result.deployment?.id },
          userId: request.authUser!.id,
          environmentId: service?.server.environmentId,
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Deployment failed';

        await logAudit({
          action: 'deploy',
          resourceType: 'service',
          resourceId: id,
          resourceName: service?.name,
          details: { imageTag: body.data.imageTag },
          success: false,
          error: message,
          userId: request.authUser!.id,
          environmentId: service?.server.environmentId,
        });

        return reply.code(500).send({ error: message });
      }
    }
  );

  // Get deployment history
  fastify.get(
    '/api/services/:id/deployments',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const deployments = await getDeploymentHistory(id, limit ? parseInt(limit) : 20);
      return { deployments };
    }
  );

  // Get single deployment
  fastify.get(
    '/api/deployments/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await getDeployment(id);

      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      return { deployment };
    }
  );

  // Get container logs
  fastify.get(
    '/api/services/:id/logs',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { tail } = request.query as { tail?: string };

      try {
        const logs = await getContainerLogs(id, tail ? parseInt(tail) : 100);
        return { logs };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get logs';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Stream container logs (SSE)
  fastify.get(
    '/api/services/:id/logs/stream',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Create appropriate client based on hostname
      const { client, error } = await createClientForServer(
        service.server.hostname,
        service.server.environmentId,
        getEnvironmentSshKey,
        { serverType: service.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        await client.connect();

        // Get default log lines from system settings
        const settings = await getSystemSettings();
        const defaultLogLines = settings.defaultLogLines;

        // Stream logs (add PATH for non-interactive SSH)
        await client.execStream(
          `export PATH="/usr/local/bin:/usr/bin:$PATH" && docker logs -f --tail ${defaultLogLines} ${service.containerName}`,
          (data, isStderr) => {
            const eventType = isStderr ? 'stderr' : 'stdout';
            reply.raw.write(`event: ${eventType}\n`);
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Stream error';
        reply.raw.write(`event: error\n`);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      } finally {
        client.disconnect();
        reply.raw.end();
      }
    }
  );

  // Get available image tags
  fastify.get(
    '/api/services/:id/image-tags',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const tags = await getLatestImageTags(id);
        return { tags };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get tags';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Restart container
  fastify.post(
    '/api/services/:id/restart',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Create appropriate client based on hostname
      const { client, error } = await createClientForServer(
        service.server.hostname,
        service.server.environmentId,
        getEnvironmentSshKey,
        { serverType: service.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      const docker = new DockerSSH(client);

      try {
        await client.connect();
        await docker.restartContainer(service.containerName);

        await logAudit({
          action: 'restart',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          details: { containerName: service.containerName, serverName: service.server.name },
          userId: request.authUser!.id,
          environmentId: service.server.environmentId,
        });

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Restart failed';

        await logAudit({
          action: 'restart',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          success: false,
          error: message,
          userId: request.authUser!.id,
          environmentId: service.server.environmentId,
        });

        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
      }
    }
  );

  // Health check service - comprehensive refresh of all service info
  fastify.post(
    '/api/services/:id/health',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Create appropriate client based on hostname
      const { client, error } = await createClientForServer(
        service.server.hostname,
        service.server.environmentId,
        getEnvironmentSshKey,
        { serverType: service.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      const docker = new DockerSSH(client);
      const start = Date.now();

      try {
        await client.connect();

        // Get comprehensive container info (state, health, ports, image)
        const containerInfo = await docker.getContainerInfo(service.containerName);

        // Check URL health if configured
        let urlHealth: { success: boolean; statusCode?: number; error?: string } | null = null;
        if (service.healthCheckUrl) {
          urlHealth = await docker.checkUrl(service.healthCheckUrl);
        }

        // Determine container status
        const containerStatus = containerInfo.state;

        // Determine health status using shared function
        const healthStatus = determineHealthStatus(
          containerInfo.health,
          containerInfo.running,
          urlHealth
        );

        // Determine overall status using shared function
        const status = determineOverallStatus(
          containerInfo.state,
          containerInfo.running,
          healthStatus
        );

        // Serialize ports to JSON
        const exposedPorts = containerInfo.ports.length > 0
          ? JSON.stringify(containerInfo.ports)
          : null;

        // Extract current image tag from running container
        const currentImageTag = containerInfo.image ? containerInfo.image.split(':')[1] || service.imageTag : service.imageTag;

        // Update service with all refreshed data
        await prisma.service.update({
          where: { id },
          data: {
            status,
            containerStatus,
            healthStatus,
            exposedPorts,
            imageTag: currentImageTag,
            discoveryStatus: containerInfo.state === CONTAINER_STATUS.NOT_FOUND ? DISCOVERY_STATUS.MISSING : DISCOVERY_STATUS.FOUND,
            lastCheckedAt: new Date(),
            lastDiscoveredAt: containerInfo.state !== CONTAINER_STATUS.NOT_FOUND ? new Date() : service.lastDiscoveredAt,
          },
        });

        // Build container health response for compatibility
        const containerHealth = {
          state: containerInfo.state,
          status: containerInfo.running ? 'Running' : `Container is ${containerInfo.state}`,
          health: containerInfo.health,
          running: containerInfo.running,
        };

        // Check for available image updates (uses containerImage.registryConnectionId)
        let updateInfo: { hasUpdate: boolean; bestTag?: string } | null = null;
        try {
          const updateResult = await checkServiceUpdate(id);
          if (!updateResult.error) {
            updateInfo = {
              hasUpdate: updateResult.hasUpdate,
              bestTag: updateResult.bestTag,
            };
          }
        } catch (err) {
          console.error(`[HealthCheck] Failed to check updates for ${service.name}:`, err);
        }

        const durationMs = Date.now() - start;
        const isHealthy = containerInfo.running && (urlHealth === null || urlHealth.success);

        await logAudit({
          action: 'health_check',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          details: { status, containerStatus, healthStatus, containerHealth, urlHealth, exposedPorts, updateInfo },
          userId: request.authUser!.id,
          environmentId: service.server.environmentId,
        });

        await logHealthCheck({
          environmentId: service.server.environmentId,
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          checkType: urlHealth ? 'url' : 'container_health',
          status: isHealthy ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
          durationMs,
          httpStatus: urlHealth?.statusCode,
          errorMessage: urlHealth?.error,
        });

        return {
          status,
          containerStatus,
          healthStatus,
          container: containerHealth,
          url: urlHealth,
          exposedPorts: containerInfo.ports,
          imageTag: currentImageTag,
          lastCheckedAt: new Date().toISOString(),
          updateInfo,
        };
      } catch (error) {
        const durationMs = Date.now() - start;
        const message = error instanceof Error ? error.message : 'Health check failed';

        // Update status to unknown on error
        await prisma.service.update({
          where: { id },
          data: {
            status: HEALTH_STATUS.UNKNOWN,
            containerStatus: HEALTH_STATUS.UNKNOWN,
            healthStatus: HEALTH_STATUS.UNKNOWN,
            lastCheckedAt: new Date(),
          },
        });

        await logAudit({
          action: 'health_check',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          success: false,
          error: message,
          userId: request.authUser!.id,
          environmentId: service.server.environmentId,
        });

        await logHealthCheck({
          environmentId: service.server.environmentId,
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          checkType: 'url',
          status: HEALTH_CHECK_STATUS.FAILURE,
          durationMs,
          errorMessage: message,
        });

        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
      }
    }
  );

  // Get service action history
  fastify.get(
    '/api/services/:id/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Get audit logs for this service (deploy, restart, health_check actions)
      const logs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'service',
          resourceId: id,
          action: { in: ['deploy', 'restart', 'health_check', 'update', 'create'] },
        },
        orderBy: { createdAt: 'desc' },
        take: limit ? parseInt(limit, 10) : 50,
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
        },
      });

      // Also get deployments for this service
      const deployments = await prisma.deployment.findMany({
        where: { serviceId: id },
        orderBy: { startedAt: 'desc' },
        take: limit ? parseInt(limit, 10) : 20,
        select: {
          id: true,
          imageTag: true,
          status: true,
          triggeredBy: true,
          startedAt: true,
          completedAt: true,
        },
      });

      return { logs, deployments };
    }
  );

  // Check for updates
  fastify.post(
    '/api/services/:id/check-updates',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: { server: true, containerImage: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      const result = await checkServiceUpdate(id);

      if (result.error) {
        return reply.code(400).send({ error: result.error });
      }

      // Fetch updated container image data
      const updatedContainerImage = await prisma.containerImage.findUnique({
        where: { id: service.containerImageId },
        select: {
          lastCheckedAt: true,
          updateAvailable: true,
        },
      });

      return {
        hasUpdate: result.hasUpdate,
        currentTag: service.imageTag,
        bestTag: result.bestTag,
        newestDigestId: result.newestDigestId,
        lastUpdateCheckAt: updatedContainerImage?.lastCheckedAt,
      };
    }
  );

  // Get command for a predefined command (for CLI)
  fastify.post(
    '/api/services/:id/run-command',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = runCommandSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const service = await prisma.service.findUnique({
        where: { id },
        include: {
          serviceType: {
            include: {
              commands: true,
            },
          },
          server: true,
        },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      if (!service.serviceType) {
        return reply.code(400).send({ error: 'Service has no service type configured' });
      }

      const command = service.serviceType.commands.find(
        (cmd) => cmd.name === body.data.commandName
      );

      if (!command) {
        return reply.code(404).send({
          error: `Command '${body.data.commandName}' not found`,
          availableCommands: service.serviceType.commands.map((c) => c.name),
        });
      }

      await logAudit({
        action: 'run_command',
        resourceType: 'service',
        resourceId: id,
        resourceName: service.name,
        details: { commandName: body.data.commandName, command: command.command },
        userId: request.authUser!.id,
        environmentId: service.server.environmentId,
      });

      return { command: command.command };
    }
  );
}
