import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import { createClientForServer, type CommandClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { logAudit } from '../services/audit.js';
import { resolveSecretPlaceholders } from '../services/secrets.js';

const createConfigFileSchema = z.object({
  name: z.string().min(1),
  filename: z.string().min(1),
  content: z.string(),
  description: z.string().optional(),
  isBinary: z.boolean().optional(),
  mimeType: z.string().optional(),
  fileSize: z.number().int().positive().optional(),
});

const updateConfigFileSchema = z.object({
  name: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  content: z.string().optional(),
  description: z.string().nullable().optional(),
  isBinary: z.boolean().optional(),
  mimeType: z.string().nullable().optional(),
  fileSize: z.number().int().positive().nullable().optional(),
});

const attachFileSchema = z.object({
  configFileId: z.string(),
  targetPath: z.string().min(1),
});

export async function configFileRoutes(fastify: FastifyInstance): Promise<void> {
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
          isBinary: true,
          mimeType: true,
          fileSize: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { services: true } },
          services: {
            select: {
              targetPath: true,
              service: {
                select: {
                  id: true,
                  name: true,
                  server: { select: { id: true, name: true } },
                },
              },
            },
          },
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
        if (!existing) {
          return reply.code(404).send({ error: 'Config file not found' });
        }

        // Save history if content is being updated
        if (body.data.content !== undefined && body.data.content !== existing.content) {
          await prisma.fileHistory.create({
            data: {
              content: existing.content,
              configFileId: id,
              editedById: request.authUser!.id,
            },
          });
        }

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
          environmentId: existing.environmentId,
        });

        return { configFile };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Config file not found' });
        }
        throw error;
      }
    }
  );

  // Get config file history
  fastify.get(
    '/api/config-files/:id/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const configFile = await prisma.configFile.findUnique({ where: { id } });
      if (!configFile) {
        return reply.code(404).send({ error: 'Config file not found' });
      }

      const history = await prisma.fileHistory.findMany({
        where: { configFileId: id },
        select: {
          id: true,
          content: true,
          editedAt: true,
          editedBy: { select: { id: true, email: true, name: true } },
        },
        orderBy: { editedAt: 'desc' },
        take: 50,
      });

      return { history };
    }
  );

  // Restore config file from history
  fastify.post(
    '/api/config-files/:id/restore/:historyId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id, historyId } = request.params as { id: string; historyId: string };

      const configFile = await prisma.configFile.findUnique({ where: { id } });
      if (!configFile) {
        return reply.code(404).send({ error: 'Config file not found' });
      }

      const historyEntry = await prisma.fileHistory.findUnique({ where: { id: historyId } });
      if (!historyEntry || historyEntry.configFileId !== id) {
        return reply.code(404).send({ error: 'History entry not found' });
      }

      // Save current content as new history entry before restoring
      await prisma.fileHistory.create({
        data: {
          content: configFile.content,
          configFileId: id,
          editedById: request.authUser!.id,
        },
      });

      // Restore content from history
      const updated = await prisma.configFile.update({
        where: { id },
        data: { content: historyEntry.content },
      });

      await logAudit({
        action: 'restore',
        resourceType: 'config_file',
        resourceId: configFile.id,
        resourceName: configFile.name,
        details: { restoredFrom: historyId, restoredAt: historyEntry.editedAt },
        userId: request.authUser!.id,
        environmentId: configFile.environmentId,
      });

      return { configFile: updated };
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
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Config file not found' });
        }
        throw error;
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
                select: {
                  id: true,
                  name: true,
                  filename: true,
                  description: true,
                  isBinary: true,
                  mimeType: true,
                  fileSize: true,
                },
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
            configFile: {
              select: {
                id: true,
                name: true,
                filename: true,
                description: true,
                isBinary: true,
                mimeType: true,
                fileSize: true,
              },
            },
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
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'File attachment not found' });
        }
        throw error;
      }
    }
  );

  // Update service file target path
  fastify.patch(
    '/api/services/:serviceId/files/:fileId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { serviceId, fileId } = request.params as { serviceId: string; fileId: string };
      const body = z.object({ targetPath: z.string().min(1) }).safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

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

        const updated = await prisma.serviceFile.update({
          where: { id: serviceFile.id },
          data: { targetPath: body.data.targetPath },
          include: {
            configFile: {
              select: {
                id: true,
                name: true,
                filename: true,
                description: true,
                isBinary: true,
                mimeType: true,
                fileSize: true,
              },
            },
          },
        });

        await logAudit({
          action: 'update',
          resourceType: 'service_file',
          resourceId: serviceFile.id,
          resourceName: `${serviceFile.configFile.name} -> ${serviceFile.service.name}`,
          details: { oldTargetPath: serviceFile.targetPath, newTargetPath: body.data.targetPath },
          userId: request.authUser!.id,
          environmentId: serviceFile.service.server.environmentId,
        });

        return { serviceFile: updated };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'File attachment not found' });
        }
        throw error;
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

      // Create appropriate client based on hostname
      const { client, error: clientError } = await createClientForServer(
        service.server.hostname,
        service.server.environmentId,
        getEnvironmentSshKey
      );
      if (!client) {
        return reply.code(400).send({ error: clientError });
      }

      const results: Array<{ file: string; targetPath: string; success: boolean; error?: string }> = [];

      try {
        await client.connect();

        for (const serviceFile of service.files) {
          const { configFile, targetPath } = serviceFile;

          try {
            // Ensure target directory exists
            const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
            await client.exec(`mkdir -p "${targetDir}"`);

            let code: number;
            let stderr: string;

            if (configFile.isBinary) {
              // Binary files: content is base64-encoded, decode on the server
              ({ code, stderr } = await client.exec(
                `echo "${configFile.content}" | base64 -d > "${targetPath}"`
              ));
            } else {
              // Text files: resolve ${SECRET_KEY} placeholders and trim trailing empty lines
              const { content: rawContent, missing } = await resolveSecretPlaceholders(
                service.server.environmentId,
                configFile.content
              );
              const resolvedContent = rawContent.trimEnd();

              if (missing.length > 0) {
                results.push({
                  file: configFile.name,
                  targetPath,
                  success: false,
                  error: `Missing secrets: ${missing.join(', ')}`,
                });
                continue;
              }

              // Write file content using heredoc with quoted delimiter to prevent shell expansion
              ({ code, stderr } = await client.exec(
                `cat > "${targetPath}" << 'CONFIGFILE_EOF'\n${resolvedContent}\nCONFIGFILE_EOF`
              ));
            }

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
        const message = error instanceof Error ? error.message : 'Connection failed';
        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
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

  // Upload asset file (binary)
  fastify.post(
    '/api/environments/:envId/asset-files/upload',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      // Check environment exists
      const environment = await prisma.environment.findUnique({
        where: { id: envId },
      });
      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      // Get form fields - fastify multipart returns fields as objects with 'value' property
      const getFieldValue = (field: unknown): string | undefined => {
        if (!field) return undefined;
        if (typeof field === 'string') return field;
        if (Array.isArray(field)) {
          const first = field[0];
          if (first && typeof first === 'object' && 'value' in first) {
            return (first as { value: string }).value;
          }
        }
        if (typeof field === 'object' && 'value' in field) {
          return (field as { value: string }).value;
        }
        return undefined;
      };

      const name = getFieldValue(data.fields.name);
      const filename = getFieldValue(data.fields.filename) || data.filename;
      const description = getFieldValue(data.fields.description);

      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!filename) {
        return reply.code(400).send({ error: 'filename is required' });
      }

      // Read file and convert to base64
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);
      const content = fileBuffer.toString('base64');
      const fileSize = fileBuffer.length;
      const mimeType = data.mimetype || 'application/octet-stream';

      try {
        const configFile = await prisma.configFile.create({
          data: {
            name,
            filename,
            content,
            description: description || null,
            isBinary: true,
            mimeType,
            fileSize,
            environmentId: envId,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          details: { isBinary: true, mimeType, fileSize },
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
}
