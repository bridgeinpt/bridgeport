import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { SSHClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { logAudit } from '../services/audit.js';

const createConfigFileSchema = z.object({
  name: z.string().min(1),
  filename: z.string().min(1),
  content: z.string(),
  description: z.string().optional(),
});

const updateConfigFileSchema = z.object({
  name: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  content: z.string().optional(),
  description: z.string().nullable().optional(),
});

const attachFileSchema = z.object({
  configFileId: z.string(),
  targetPath: z.string().min(1),
});

export async function configFileRoutes(fastify: FastifyInstance) {
  // List config files for environment
  fastify.get(
    '/api/environments/:envId/config-files',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const configFiles = await prisma.configFile.findMany({
        where: { environmentId: envId },
        select: {
          id: true,
          name: true,
          filename: true,
          description: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { services: true } },
        },
        orderBy: { name: 'asc' },
      });

      return { configFiles };
    }
  );

  // Get config file with content
  fastify.get(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const configFile = await prisma.configFile.findUnique({
        where: { id },
        include: {
          services: {
            include: {
              service: {
                select: { id: true, name: true, server: { select: { id: true, name: true } } },
              },
            },
          },
        },
      });

      if (!configFile) {
        return reply.code(404).send({ error: 'Config file not found' });
      }

      return { configFile };
    }
  );

  // Create config file
  fastify.post(
    '/api/environments/:envId/config-files',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createConfigFileSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const configFile = await prisma.configFile.create({
          data: {
            ...body.data,
            environmentId: envId,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { configFile };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Config file with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Update config file
  fastify.patch(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateConfigFileSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.configFile.findUnique({ where: { id } });
        const configFile = await prisma.configFile.update({
          where: { id },
          data: body.data,
        });

        await logAudit({
          action: 'update',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { configFile };
      } catch {
        return reply.code(404).send({ error: 'Config file not found' });
      }
    }
  );

  // Delete config file
  fastify.delete(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const configFile = await prisma.configFile.findUnique({ where: { id } });
        await prisma.configFile.delete({ where: { id } });

        if (configFile) {
          await logAudit({
            action: 'delete',
            resourceType: 'config_file',
            resourceId: id,
            resourceName: configFile.name,
            userId: request.authUser!.id,
            environmentId: configFile.environmentId,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Config file not found' });
      }
    }
  );

  // Get files attached to a service
  fastify.get(
    '/api/services/:id/files',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: {
          files: {
            include: {
              configFile: {
                select: { id: true, name: true, filename: true, description: true },
              },
            },
          },
        },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      return { files: service.files };
    }
  );

  // Attach file to service
  fastify.post(
    '/api/services/:id/files',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = attachFileSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const serviceFile = await prisma.serviceFile.create({
          data: {
            serviceId: id,
            configFileId: body.data.configFileId,
            targetPath: body.data.targetPath,
          },
          include: {
            configFile: { select: { id: true, name: true, filename: true } },
          },
        });

        const service = await prisma.service.findUnique({
          where: { id },
          include: { server: true },
        });

        await logAudit({
          action: 'attach',
          resourceType: 'service_file',
          resourceId: serviceFile.id,
          resourceName: `${serviceFile.configFile.name} -> ${service?.name}`,
          details: { targetPath: body.data.targetPath },
          userId: request.authUser!.id,
          environmentId: service?.server.environmentId,
        });

        return { serviceFile };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'File already attached to this service' });
        }
        throw error;
      }
    }
  );

  // Detach file from service
  fastify.delete(
    '/api/services/:serviceId/files/:fileId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { serviceId, fileId } = request.params as { serviceId: string; fileId: string };

      try {
        const serviceFile = await prisma.serviceFile.findFirst({
          where: { serviceId, configFileId: fileId },
          include: {
            configFile: { select: { name: true } },
            service: { include: { server: true } },
          },
        });

        if (!serviceFile) {
          return reply.code(404).send({ error: 'File not attached to this service' });
        }

        await prisma.serviceFile.delete({ where: { id: serviceFile.id } });

        await logAudit({
          action: 'detach',
          resourceType: 'service_file',
          resourceId: serviceFile.id,
          resourceName: `${serviceFile.configFile.name} -> ${serviceFile.service.name}`,
          userId: request.authUser!.id,
          environmentId: serviceFile.service.server.environmentId,
        });

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'File attachment not found' });
      }
    }
  );

  // Sync files to server (copy all attached files to their target paths)
  fastify.post(
    '/api/services/:id/sync-files',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await prisma.service.findUnique({
        where: { id },
        include: {
          server: true,
          files: {
            include: { configFile: true },
          },
        },
      });

      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      if (service.files.length === 0) {
        return reply.code(400).send({ error: 'No files attached to this service' });
      }

      // Get SSH credentials
      const sshCreds = await getEnvironmentSshKey(service.server.environmentId);
      if (!sshCreds) {
        return reply.code(400).send({ error: 'SSH key not configured for this environment' });
      }

      const ssh = new SSHClient({
        hostname: service.server.hostname,
        username: sshCreds.username,
        privateKey: sshCreds.privateKey,
      });

      const results: Array<{ file: string; targetPath: string; success: boolean; error?: string }> = [];

      try {
        await ssh.connect();

        for (const serviceFile of service.files) {
          const { configFile, targetPath } = serviceFile;

          try {
            // Ensure target directory exists
            const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
            await ssh.exec(`mkdir -p "${targetDir}"`);

            // Write file content using heredoc with quoted delimiter to prevent shell expansion
            const { code, stderr } = await ssh.exec(
              `cat > "${targetPath}" << 'CONFIGFILE_EOF'\n${configFile.content}\nCONFIGFILE_EOF`
            );

            if (code !== 0) {
              results.push({
                file: configFile.name,
                targetPath,
                success: false,
                error: stderr || 'Failed to write file',
              });
            } else {
              results.push({ file: configFile.name, targetPath, success: true });
            }
          } catch (err) {
            results.push({
              file: configFile.name,
              targetPath,
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'SSH connection failed';
        return reply.code(500).send({ error: message });
      } finally {
        ssh.disconnect();
      }

      const allSuccess = results.every((r) => r.success);

      await logAudit({
        action: 'sync_files',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { results, allSuccess },
        success: allSuccess,
        userId: request.authUser!.id,
        environmentId: service.server.environmentId,
      });

      return { results, success: allSuccess };
    }
  );
}
