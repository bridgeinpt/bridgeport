import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  deployService,
  getDeploymentHistory,
  getDeployment,
  getContainerLogs,
  getLatestImageTags,
} from '../services/deploy.js';
import { SSHClient, LocalClient, DockerSSH, isLocalhost } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { logAudit } from '../services/audit.js';
import { checkServiceUpdate } from '../lib/scheduler.js';

const createServiceSchema = z.object({
  name: z.string().min(1),
  containerName: z.string().min(1),
  imageName: z.string().min(1),
  imageTag: z.string().default('latest'),
  composePath: z.string().optional(),
  envTemplateName: z.string().optional(),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  containerName: z.string().min(1).optional(),
  imageName: z.string().min(1).optional(),
  imageTag: z.string().optional(),
  composePath: z.string().nullable().optional(),
  envTemplateName: z.string().nullable().optional(),
  healthCheckUrl: z.string().nullable().optional(),
  autoUpdate: z.boolean().optional(),
  registryConnectionId: z.string().nullable().optional(),
});

const deploySchema = z.object({
  imageTag: z.string().optional(),
  generateArtifacts: z.boolean().default(true),
  pullImage: z.boolean().default(true),
});

export async function serviceRoutes(fastify: FastifyInstance) {
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
          details: { containerName: service.containerName, imageName: service.imageName },
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
      } catch {
        return reply.code(404).send({ error: 'Service not found' });
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
      } catch {
        return reply.code(404).send({ error: 'Service not found' });
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
      let client;
      if (isLocalhost(service.server.hostname)) {
        client = new LocalClient();
      } else {
        const sshCreds = await getEnvironmentSshKey(service.server.environmentId);
        if (!sshCreds) {
          return reply.code(400).send({ error: 'SSH key not configured for this environment' });
        }
        client = new SSHClient({
          hostname: service.server.hostname,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        await client.connect();

        // Stream logs (add PATH for non-interactive SSH)
        await client.execStream(
          `export PATH="/usr/local/bin:/usr/bin:$PATH" && docker logs -f --tail 50 ${service.containerName}`,
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

      const service = await prisma.service.findUnique({
        where: { id },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Extract repository name from full image name
      const repoName = service.imageName.replace('registry.digitalocean.com/bios-registry/', '');

      try {
        const tags = await getLatestImageTags(repoName);
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
      let client;
      if (isLocalhost(service.server.hostname)) {
        client = new LocalClient();
      } else {
        const sshCreds = await getEnvironmentSshKey(service.server.environmentId);
        if (!sshCreds) {
          return reply.code(400).send({ error: 'SSH key not configured for this environment' });
        }
        client = new SSHClient({
          hostname: service.server.hostname,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        });
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

  // Health check service
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
      let client;
      if (isLocalhost(service.server.hostname)) {
        client = new LocalClient();
      } else {
        const sshCreds = await getEnvironmentSshKey(service.server.environmentId);
        if (!sshCreds) {
          return reply.code(400).send({ error: 'SSH key not configured for this environment' });
        }
        client = new SSHClient({
          hostname: service.server.hostname,
          username: sshCreds.username,
          privateKey: sshCreds.privateKey,
        });
      }

      const docker = new DockerSSH(client);

      try {
        await client.connect();

        // Check container health
        const containerHealth = await docker.getContainerHealth(service.containerName);

        // Check URL health if configured
        let urlHealth: { success: boolean; statusCode?: number; error?: string } | null = null;
        if (service.healthCheckUrl) {
          urlHealth = await docker.checkUrl(service.healthCheckUrl);
        }

        // Determine overall status
        let status: string;
        if (!containerHealth.running) {
          status = containerHealth.state === 'not_found' ? 'not_found' : 'stopped';
        } else if (containerHealth.health === 'unhealthy') {
          status = 'unhealthy';
        } else if (urlHealth && !urlHealth.success) {
          status = 'unhealthy';
        } else if (containerHealth.health === 'healthy' || (urlHealth && urlHealth.success)) {
          status = 'healthy';
        } else {
          status = 'running';
        }

        // Update service status in database
        await prisma.service.update({
          where: { id },
          data: {
            status,
            lastCheckedAt: new Date(),
          },
        });

        await logAudit({
          action: 'health_check',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          details: { status, containerHealth, urlHealth },
          userId: request.authUser!.id,
          environmentId: service.server.environmentId,
        });

        return {
          status,
          container: containerHealth,
          url: urlHealth,
          lastCheckedAt: new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Health check failed';

        // Update status to unknown on error
        await prisma.service.update({
          where: { id },
          data: {
            status: 'unknown',
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

        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
      }
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
        include: { server: true },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      const result = await checkServiceUpdate(id);

      if (result.error) {
        return reply.code(400).send({ error: result.error });
      }

      // Fetch updated service data
      const updatedService = await prisma.service.findUnique({
        where: { id },
        select: {
          latestAvailableTag: true,
          latestAvailableDigest: true,
          lastUpdateCheckAt: true,
        },
      });

      return {
        hasUpdate: result.hasUpdate,
        currentTag: service.imageTag,
        latestTag: result.latestTag,
        latestDigest: result.latestDigest,
        lastUpdateCheckAt: updatedService?.lastUpdateCheckAt,
      };
    }
  );
}
