import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import { createClientForServer, shellEscape, type CommandClient } from '../lib/ssh.js';
import { getEnvironmentSshKey } from './environments.js';
import { requireOperator } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { resolveSecretPlaceholders } from '../services/secrets.js';
import {
  syncConfigFileToAttachedServices,
  syncConfigFileToAttachedServicesDryRun,
  deriveSyncStatus,
  listReferencingServiceNames,
} from '../services/config-file-auto-resync.js';
import { validateBody, validateUpdateBody, findOrNotFound, handleUniqueConstraint, getErrorMessage, parsePaginationQuery } from '../lib/helpers.js';
import { detectLanguage } from '../lib/config-file-language.js';
import { syncUsageForConfigFile } from '../lib/key-usage-extraction.js';
import { composeFragmentedContent } from '../lib/config-fragments.js';
import {
  isDryRun,
  redactSecretValues,
  unifiedDiff,
  type ConfigSyncTarget,
} from '../lib/dry-run.js';
import { getSecretsForEnv } from '../services/secrets.js';

const createConfigFileSchema = z.object({
  name: z.string().min(1),
  filename: z.string().min(1),
  content: z.string().min(1, 'Content is required'),
  description: z.string().optional(),
  isBinary: z.boolean().optional(),
  mimeType: z.string().optional(),
  fileSize: z.number().int().positive().optional(),
  autoResync: z.boolean().optional(),
  language: z.string().min(1).optional(),
  // Ordered fragment ids to include in this ConfigFile's effective content.
  // Position is derived from array index. Empty/omitted = no fragments.
  fragmentIds: z.array(z.string()).optional(),
});

const updateConfigFileSchema = z.object({
  name: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  content: z.string().optional(),
  description: z.string().nullable().optional(),
  isBinary: z.boolean().optional(),
  mimeType: z.string().nullable().optional(),
  fileSize: z.number().int().positive().nullable().optional(),
  autoResync: z.boolean().optional(),
  language: z.string().min(1).optional(),
  // Full-replace semantics: when provided, all existing ConfigFileFragment
  // rows for this ConfigFile are deleted and re-created in array order.
  fragmentIds: z.array(z.string()).optional(),
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
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);
      const where = { environmentId: envId };

      const [configFiles, total] = await Promise.all([
        prisma.configFile.findMany({
          where,
          select: {
            id: true,
            name: true,
            filename: true,
            description: true,
            isBinary: true,
            mimeType: true,
            fileSize: true,
            autoResync: true,
            language: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { services: true } },
            services: {
              select: {
                id: true,
                targetPath: true,
                lastSyncedAt: true,
                kind: true,
                serviceDeploymentId: true,
                service: {
                  select: {
                    id: true,
                    name: true,
                    serviceDeployments: { select: { id: true, server: { select: { id: true, name: true } } } },
                  },
                },
                serviceDeployment: {
                  select: { id: true, server: { select: { id: true, name: true } } },
                },
              },
            },
          },
          orderBy: { name: 'asc' },
          take: limit,
          skip: offset,
        }),
        prisma.configFile.count({ where }),
      ]);

      // Compute sync status for each config file
      const configFilesWithSyncStatus = configFiles.map((file) => {
        // Determine sync status based on service attachments
        let syncStatus: 'synced' | 'pending' | 'never' | 'not_attached' = 'not_attached';
        let pendingCount = 0;
        let syncedCount = 0;
        let neverSyncedCount = 0;

        if (file.services.length > 0) {
          for (const sf of file.services) {
            if (!sf.lastSyncedAt) {
              neverSyncedCount++;
            } else if (new Date(sf.lastSyncedAt) < new Date(file.updatedAt)) {
              // File was updated after last sync
              pendingCount++;
            } else {
              syncedCount++;
            }
          }

          if (neverSyncedCount === file.services.length) {
            syncStatus = 'never';
          } else if (pendingCount > 0 || neverSyncedCount > 0) {
            syncStatus = 'pending';
          } else {
            syncStatus = 'synced';
          }
        }

        return {
          ...file,
          syncStatus,
          syncCounts: {
            synced: syncedCount,
            pending: pendingCount,
            never: neverSyncedCount,
            total: file.services.length,
          },
        };
      });

      return { configFiles: configFilesWithSyncStatus, total };
    }
  );

  // Get config file with content
  fastify.get(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const configFile = await findOrNotFound(
        prisma.configFile.findUnique({
          where: { id },
          include: {
            services: {
              include: {
                service: {
                  select: { id: true, name: true, serviceDeployments: { select: { id: true, server: { select: { id: true, name: true } } } } },
                },
                serviceDeployment: {
                  select: { id: true, server: { select: { id: true, name: true } } },
                },
              },
            },
            // Surface the ordered fragment includes so the editor UI can show
            // (and reorder) them without a second round-trip.
            includedFragments: {
              orderBy: { position: 'asc' },
              include: {
                fragment: {
                  select: { id: true, name: true, description: true },
                },
              },
            },
          },
        }),
        'Config file',
        reply
      );
      if (!configFile) return;

      // Add sync status to each service attachment
      const servicesWithSyncStatus = configFile.services.map((sf) => {
        let syncStatus: 'synced' | 'pending' | 'never' = 'never';
        if (sf.lastSyncedAt) {
          syncStatus = new Date(sf.lastSyncedAt) >= new Date(configFile.updatedAt) ? 'synced' : 'pending';
        }
        return {
          ...sf,
          syncStatus,
        };
      });

      // Strip binary content from response — frontend only needs metadata
      const responseFile = configFile.isBinary
        ? { ...configFile, content: '', services: servicesWithSyncStatus }
        : { ...configFile, services: servicesWithSyncStatus };
      return { configFile: responseFile };
    }
  );

  // Create config file
  fastify.post(
    '/api/environments/:envId/config-files',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createConfigFileSchema, request, reply);
      if (!body) return;

      try {
        // Auto-detect syntax-highlighting language from filename when the
        // caller didn't supply one. Binary files always fall back to the
        // model default ("plaintext") since highlighting doesn't apply.
        const language =
          body.language ?? (body.isBinary ? undefined : detectLanguage(body.filename));

        // Wrap content write + usage sync in a transaction so they commit or
        // roll back together — otherwise a sync failure would leave the file
        // saved with no usage rows tracked.
        const { fragmentIds, ...createData } = body;
        const configFile = await prisma.$transaction(async (tx) => {
          const cf = await tx.configFile.create({
            data: {
              ...createData,
              ...(language !== undefined ? { language } : {}),
              environmentId: envId,
            },
          });
          // Populate Secret/VarUsage rows so the secrets/vars list endpoints
          // can resolve "where is this key used?" via a join instead of
          // scanning content. Binary files skip extraction inside the helper.
          await syncUsageForConfigFile(tx, cf);
          // Persist ordered fragment includes. Position is the array index
          // (caller controls order).
          if (fragmentIds && fragmentIds.length > 0) {
            await tx.configFileFragment.createMany({
              data: fragmentIds.map((fragmentId, position) => ({
                configFileId: cf.id,
                fragmentId,
                position,
              })),
            });
          }
          return cf;
        });

        await logAudit({
          action: 'create',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          ...actorFrom(request),
          environmentId: envId,
        });

        // Strip binary content from response — frontend only needs metadata
        if (configFile.isBinary) {
          return { configFile: { ...configFile, content: '' } };
        }
        return { configFile };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Config file with this name already exists', reply)) return;
        throw error;
      }
    }
  );

  // Update config file
  fastify.patch(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Rejects PATCH of derived/system fields (id, createdAt, etc.) atomically.
      const body = validateUpdateBody(updateConfigFileSchema, 'configFile', request, reply);
      if (!body) return;

      try {
        const existing = await findOrNotFound(
          prisma.configFile.findUnique({ where: { id } }),
          'Config file',
          reply
        );
        if (!existing) return;

        // Save history if content is being updated
        if (body.content !== undefined && body.content !== existing.content) {
          await prisma.fileHistory.create({
            data: {
              content: existing.content,
              configFileId: id,
              editedById: userIdForFk(request.authUser!),
            },
          });
        }

        // Wrap content write + usage sync + fragment-include replacement in a
        // single transaction so all three commit or roll back together.
        const { fragmentIds, ...updateData } = body;
        const configFile = await prisma.$transaction(async (tx) => {
          const cf = await tx.configFile.update({
            where: { id },
            data: updateData,
          });
          // Re-sync Secret/VarUsage rows whenever the content or isBinary flag
          // could have changed. Cheap when nothing changed (single findMany).
          if (body.content !== undefined || body.isBinary !== undefined) {
            await syncUsageForConfigFile(tx, cf);
          }
          // Full-replace fragment includes when caller supplied the list.
          // Undefined = leave existing rows alone (PATCH semantics).
          if (fragmentIds !== undefined) {
            await tx.configFileFragment.deleteMany({ where: { configFileId: id } });
            if (fragmentIds.length > 0) {
              await tx.configFileFragment.createMany({
                data: fragmentIds.map((fragmentId, position) => ({
                  configFileId: id,
                  fragmentId,
                  position,
                })),
              });
            }
          }
          return cf;
        });

        await logAudit({
          action: 'update',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          ...actorFrom(request),
          environmentId: existing.environmentId,
        });

        // Strip binary content from response
        if (configFile.isBinary) {
          return { configFile: { ...configFile, content: '' } };
        }
        return { configFile };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Config file not found' });
        }
        throw error;
      }
    }
  );

  // Preview rendered/merged content: fragments concatenated (in position
  // order) before the ConfigFile's own content, with `${KEY}` placeholders
  // resolved against the environment's vars/secrets. Used by the editor to
  // show what will actually be written to the server before save/deploy.
  //
  // Secret values appear in clear in this preview — callers should treat the
  // response as sensitive (the route requires authentication via the global
  // auth handler). The compose dry-run preview is the redacted equivalent.
  fastify.post(
    '/api/config-files/:id/preview',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const configFile = await findOrNotFound(
        prisma.configFile.findUnique({
          where: { id },
          include: {
            includedFragments: {
              include: { fragment: { select: { name: true, content: true } } },
              orderBy: { position: 'asc' },
            },
          },
        }),
        'Config file',
        reply
      );
      if (!configFile) return;

      // Binary files don't go through substitution / fragment composition;
      // there's nothing meaningful to preview.
      if (configFile.isBinary) {
        return reply.code(400).send({ error: 'Preview is not supported for binary files' });
      }

      const composed = composeFragmentedContent(
        configFile.includedFragments.map((f) => ({
          name: f.fragment.name,
          content: f.fragment.content,
        })),
        configFile.content,
        configFile.language,
      );

      const { content, missing, templateErrors } = await resolveSecretPlaceholders(
        configFile.environmentId,
        composed
      );

      return { content, missing, templateErrors };
    }
  );

  // Get config file history
  fastify.get(
    '/api/config-files/:id/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const configFile = await findOrNotFound(
        prisma.configFile.findUnique({ where: { id } }),
        'Config file',
        reply
      );
      if (!configFile) return;

      const history = await prisma.fileHistory.findMany({
        where: { configFileId: id },
        select: {
          id: true,
          content: !configFile.isBinary, // Exclude content for binary files
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
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id, historyId } = request.params as { id: string; historyId: string };

      const configFile = await findOrNotFound(
        prisma.configFile.findUnique({ where: { id } }),
        'Config file',
        reply
      );
      if (!configFile) return;

      const historyEntry = await prisma.fileHistory.findUnique({ where: { id: historyId } });
      if (!historyEntry || historyEntry.configFileId !== id) {
        return reply.code(404).send({ error: 'History entry not found' });
      }

      // Save current content as new history entry before restoring
      await prisma.fileHistory.create({
        data: {
          content: configFile.content,
          configFileId: id,
          editedById: userIdForFk(request.authUser!),
        },
      });

      // Restore content from history. Wrap restore + usage sync in a
      // transaction so both commit or roll back together.
      const updated = await prisma.$transaction(async (tx) => {
        const cf = await tx.configFile.update({
          where: { id },
          data: { content: historyEntry.content },
        });
        // Re-sync usage rows for the restored content.
        await syncUsageForConfigFile(tx, cf);
        return cf;
      });

      await logAudit({
        action: 'restore',
        resourceType: 'config_file',
        resourceId: configFile.id,
        resourceName: configFile.name,
        details: { restoredFrom: historyId, restoredAt: historyEntry.editedAt },
        ...actorFrom(request),
        environmentId: configFile.environmentId,
      });

      // Strip binary content from response
      if (updated.isBinary) {
        return { configFile: { ...updated, content: '' } };
      }
      return { configFile: updated };
    }
  );

  // Delete config file
  fastify.delete(
    '/api/config-files/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
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
            ...actorFrom(request),
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

      const service = await findOrNotFound(
        prisma.service.findUnique({
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
        }),
        'Service',
        reply
      );
      if (!service) return;

      return { files: service.files };
    }
  );

  // Attach file to service
  fastify.post(
    '/api/services/:id/files',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(attachFileSchema, request, reply);
      if (!body) return;

      // The @@unique([serviceId, configFileId, serviceDeploymentId]) constraint
      // treats NULL values as distinct in SQLite, so it does NOT prevent two
      // base attachments (serviceDeploymentId = NULL) for the same (service,
      // configFile). Pre-check here to enforce uniqueness at the application
      // layer.
      const existingBaseAttachment = await prisma.serviceFile.findFirst({
        where: {
          serviceId: id,
          configFileId: body.configFileId,
          serviceDeploymentId: null,
        },
        select: { id: true },
      });
      if (existingBaseAttachment) {
        return reply.code(409).send({ error: 'File already attached to this service' });
      }

      try {
        const serviceFile = await prisma.serviceFile.create({
          data: {
            serviceId: id,
            configFileId: body.configFileId,
            targetPath: body.targetPath,
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
        });

        await logAudit({
          action: 'attach',
          resourceType: 'service_file',
          resourceId: serviceFile.id,
          resourceName: `${serviceFile.configFile.name} -> ${service?.name}`,
          details: { targetPath: body.targetPath },
          ...actorFrom(request),
          environmentId: service?.environmentId,
        });

        return { serviceFile };
      } catch (error) {
        if (handleUniqueConstraint(error, 'File already attached to this service', reply)) return;
        throw error;
      }
    }
  );

  // Detach file from service
  fastify.delete(
    '/api/services/:serviceId/files/:fileId',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { serviceId, fileId } = request.params as { serviceId: string; fileId: string };

      try {
        const serviceFile = await findOrNotFound(
          prisma.serviceFile.findFirst({
            where: { serviceId, configFileId: fileId, serviceDeploymentId: null },
            include: {
              configFile: { select: { name: true } },
              service: true,
            },
          }),
          'File attachment',
          reply
        );
        if (!serviceFile) return;

        await prisma.serviceFile.delete({ where: { id: serviceFile.id } });

        await logAudit({
          action: 'detach',
          resourceType: 'service_file',
          resourceId: serviceFile.id,
          resourceName: `${serviceFile.configFile.name} -> ${serviceFile.service.name}`,
          ...actorFrom(request),
          environmentId: serviceFile.service.environmentId,
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
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { serviceId, fileId } = request.params as { serviceId: string; fileId: string };
      const body = validateBody(z.object({ targetPath: z.string().min(1) }), request, reply);
      if (!body) return;

      try {
        const serviceFile = await findOrNotFound(
          prisma.serviceFile.findFirst({
            where: { serviceId, configFileId: fileId, serviceDeploymentId: null },
            include: {
              configFile: { select: { name: true } },
              service: true,
            },
          }),
          'File attachment',
          reply
        );
        if (!serviceFile) return;

        const updated = await prisma.serviceFile.update({
          where: { id: serviceFile.id },
          data: { targetPath: body.targetPath },
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
          details: { oldTargetPath: serviceFile.targetPath, newTargetPath: body.targetPath },
          ...actorFrom(request),
          environmentId: serviceFile.service.environmentId,
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

  // Sync files for a service template across all its deployments.
  // Fans out per ServiceDeployment, picking override files where present and falling back to base.
  fastify.post(
    '/api/services/:id/sync-files',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: {
            serviceDeployments: { include: { server: true } },
            files: {
              include: {
                configFile: {
                  include: {
                    // Ordered fragment includes — concatenated before the
                    // ConfigFile's own content at render time.
                    includedFragments: {
                      include: { fragment: true },
                      orderBy: { position: 'asc' },
                    },
                  },
                },
              },
            },
          },
        }),
        'Service',
        reply
      );
      if (!service) return;

      // Dry-run preview: render rendered (redacted) content + diff against
      // current host file per (deployment, file). Skips all writes, doesn't
      // touch `lastSyncedAt`, doesn't fail the audit log if a target is unreachable.
      if (isDryRun(request)) {
        const results: ConfigSyncTarget[] = [];

        for (const sd of service.serviceDeployments) {
          // Same override/base file resolution as the live path.
          const filesByConfig = new Map<string, typeof service.files[number]>();
          for (const sf of service.files) {
            if (sf.serviceDeploymentId === sd.id) {
              filesByConfig.set(sf.configFileId, sf);
            } else if (sf.serviceDeploymentId === null && !filesByConfig.has(sf.configFileId)) {
              filesByConfig.set(sf.configFileId, sf);
            }
          }

          if (filesByConfig.size === 0) continue;

          const secretValues = Object.values(await getSecretsForEnv(sd.server.environmentId));

          const { client, error: clientError } = await createClientForServer(
            sd.server.hostname,
            sd.server.environmentId,
            getEnvironmentSshKey,
            { serverType: sd.server.serverType }
          );

          // Resolve referencingServices once per (configFile, server) — the
          // inputs are invariant for this scope, so hoist the call out of the
          // per-target loops and out of each failure branch. Without this we
          // were either hardcoding `[service.name]` (wrong blast radius) or
          // running the same query 3× per file.
          const referencingByConfigFile = new Map<string, string[]>();
          const getReferencing = async (configFileId: string): Promise<string[]> => {
            const cached = referencingByConfigFile.get(configFileId);
            if (cached) return cached;
            const names = await listReferencingServiceNames(configFileId, sd.server.id);
            referencingByConfigFile.set(configFileId, names);
            return names;
          };

          if (!client) {
            for (const sf of filesByConfig.values()) {
              results.push({
                serverName: sd.server.name,
                serviceName: service.name,
                configFileName: sf.configFile.name,
                hostPath: sf.targetPath,
                diff: '',
                exists: false,
                referencingServices: await getReferencing(sf.configFile.id),
                warnings: [clientError || 'Failed to create SSH client'],
              });
            }
            continue;
          }

          try {
            await client.connect();
            for (const sf of filesByConfig.values()) {
              const warnings: string[] = [];
              const referencingServices = await getReferencing(sf.configFile.id);
              let renderedContent: string;

              if (sf.configFile.isBinary) {
                results.push({
                  serverName: sd.server.name,
                  serviceName: service.name,
                  configFileName: sf.configFile.name,
                  hostPath: sf.targetPath,
                  diff: '',
                  exists: false,
                  referencingServices,
                  warnings: ['Binary file — diff omitted'],
                });
                continue;
              }

              const composedSource = composeFragmentedContent(
                sf.configFile.includedFragments.map((f) => ({
                  name: f.fragment.name,
                  content: f.fragment.content,
                })),
                sf.configFile.content,
                sf.configFile.language,
              );
              const { content: rawContent, missing, templateErrors } = await resolveSecretPlaceholders(
                sd.server.environmentId,
                composedSource
              );
              // Mirror the live path: template errors / missing secrets are
              // hard failures, not warnings. Surface them via `error` and
              // skip the diff (the live path wouldn't write to this target).
              let hardError: string | null = null;
              if (templateErrors.length > 0) {
                const msg = `Template errors: ${templateErrors.join('; ')}`;
                warnings.push(msg);
                hardError = msg;
              }
              if (missing.length > 0) {
                const msg = `Missing secrets: ${missing.join(', ')}`;
                warnings.push(msg);
                hardError = hardError ? `${hardError}; ${msg}` : msg;
              }

              if (hardError) {
                results.push({
                  serverName: sd.server.name,
                  serviceName: service.name,
                  configFileName: sf.configFile.name,
                  hostPath: sf.targetPath,
                  diff: '',
                  exists: false,
                  referencingServices,
                  warnings,
                  error: hardError,
                });
                continue;
              }

              renderedContent = redactSecretValues(rawContent.trimEnd(), secretValues);

              let currentContent = '';
              let exists = false;
              try {
                // shellEscape() is mandatory: targetPath is user-supplied. `cat`
                // is the read-only equivalent of the real path's write — no
                // chance of touching the host file.
                const { stdout, code } = await client.exec(`cat ${shellEscape(sf.targetPath)} 2>/dev/null`);
                if (code === 0) {
                  currentContent = redactSecretValues(stdout.replace(/\n$/, ''), secretValues);
                  exists = true;
                }
              } catch (err) {
                warnings.push(`Could not read host file: ${getErrorMessage(err, 'unknown error')}`);
              }

              const diff = unifiedDiff(currentContent, renderedContent, {
                fromLabel: `a${sf.targetPath}`,
                toLabel: `b${sf.targetPath}`,
              });

              results.push({
                serverName: sd.server.name,
                serviceName: service.name,
                configFileName: sf.configFile.name,
                hostPath: sf.targetPath,
                diff,
                exists,
                referencingServices,
                warnings,
              });
            }
          } catch (err) {
            for (const sf of filesByConfig.values()) {
              results.push({
                serverName: sd.server.name,
                serviceName: service.name,
                configFileName: sf.configFile.name,
                hostPath: sf.targetPath,
                diff: '',
                exists: false,
                referencingServices: await getReferencing(sf.configFile.id),
                warnings: [getErrorMessage(err, 'Connection failed')],
              });
            }
          } finally {
            client.disconnect();
          }
        }

        await logAudit({
          action: 'sync_files',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: { dryRun: true, results: results.length },
          ...actorFrom(request),
          environmentId: service.environmentId,
        });

        return { dryRun: true, results };
      }

      // Zero-target syncs used to return 400 — surface as 200 + no_targets so
      // the UI can render a yellow warning ("nothing to sync") instead of a
      // red error. See issue #127.
      if (service.files.length === 0 || service.serviceDeployments.length === 0) {
        await logAudit({
          action: 'sync_files',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: {
            results: [],
            status: 'no_targets',
            reason: service.files.length === 0 ? 'no_files_attached' : 'no_deployments',
          },
          success: false,
          ...actorFrom(request),
          environmentId: service.environmentId,
        });
        return {
          results: [],
          status: 'no_targets' as const,
          targetsAttempted: 0,
          targetsSucceeded: 0,
          targetsFailed: 0,
          // Deprecated: retained for one release as a top-level alias (issue #127).
          success: false,
        };
      }

      const results: Array<{ file: string; targetPath: string; serverName: string; success: boolean; error?: string }> = [];

      for (const sd of service.serviceDeployments) {
        // Per-deployment: prefer override (serviceDeploymentId === sd.id) over base (null).
        const filesByConfig = new Map<string, typeof service.files[number]>();
        for (const sf of service.files) {
          if (sf.serviceDeploymentId === sd.id) {
            filesByConfig.set(sf.configFileId, sf);
          } else if (sf.serviceDeploymentId === null && !filesByConfig.has(sf.configFileId)) {
            filesByConfig.set(sf.configFileId, sf);
          }
        }

        const { client, error: clientError } = await createClientForServer(
          sd.server.hostname,
          sd.server.environmentId,
          getEnvironmentSshKey,
          { serverType: sd.server.serverType }
        );
        if (!client) {
          for (const sf of filesByConfig.values()) {
            results.push({ file: sf.configFile.name, targetPath: sf.targetPath, serverName: sd.server.name, success: false, error: clientError || 'Failed to create client' });
          }
          continue;
        }

        try {
          await client.connect();

          for (const serviceFile of filesByConfig.values()) {
            const { configFile, targetPath } = serviceFile;

            try {
              const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
              await client.exec(`mkdir -p ${shellEscape(targetDir)}`);

              let code: number;
              let stderr: string;

              if (configFile.isBinary) {
                const fileBuffer = Buffer.from(configFile.content, 'base64');
                try {
                  await client.writeFile(targetPath, fileBuffer);
                  code = 0;
                  stderr = '';
                } catch (writeErr) {
                  code = 1;
                  stderr = writeErr instanceof Error ? writeErr.message : 'SFTP write failed';
                }
              } else {
                const composedSource = composeFragmentedContent(
                  configFile.includedFragments.map((f) => ({
                    name: f.fragment.name,
                    content: f.fragment.content,
                  })),
                  configFile.content,
                  configFile.language,
                );
                const { content: rawContent, missing, templateErrors } = await resolveSecretPlaceholders(
                  sd.server.environmentId,
                  composedSource
                );
                const resolvedContent = rawContent.trimEnd();

                if (templateErrors.length > 0) {
                  results.push({
                    file: configFile.name,
                    targetPath,
                    serverName: sd.server.name,
                    success: false,
                    error: `Template errors: ${templateErrors.join('; ')}`,
                  });
                  continue;
                }

                if (missing.length > 0) {
                  results.push({
                    file: configFile.name,
                    targetPath,
                    serverName: sd.server.name,
                    success: false,
                    error: `Missing secrets: ${missing.join(', ')}`,
                  });
                  continue;
                }

                ({ code, stderr } = await client.exec(
                  `cat > ${shellEscape(targetPath)} << 'CONFIGFILE_EOF'\n${resolvedContent}\nCONFIGFILE_EOF`
                ));
              }

              if (code !== 0) {
                results.push({ file: configFile.name, targetPath, serverName: sd.server.name, success: false, error: stderr || 'Failed to write file' });
              } else {
                await prisma.serviceFile.update({
                  where: { id: serviceFile.id },
                  data: { lastSyncedAt: new Date() },
                });
                results.push({ file: configFile.name, targetPath, serverName: sd.server.name, success: true });
              }
            } catch (err) {
              results.push({ file: configFile.name, targetPath, serverName: sd.server.name, success: false, error: getErrorMessage(err, 'Unknown error') });
            }
          }
        } catch (error) {
          for (const sf of filesByConfig.values()) {
            results.push({ file: sf.configFile.name, targetPath: sf.targetPath, serverName: sd.server.name, success: false, error: getErrorMessage(error, 'Connection failed') });
          }
        } finally {
          client.disconnect();
        }
      }

      const status = deriveSyncStatus(results);
      const targetsAttempted = results.length;
      const targetsSucceeded = results.filter((r) => r.success).length;
      const targetsFailed = targetsAttempted - targetsSucceeded;
      const allSuccess = status === 'ok';

      await logAudit({
        action: 'sync_files',
        resourceType: 'service',
        resourceId: service.id,
        resourceName: service.name,
        details: { results, status, allSuccess },
        success: allSuccess,
        ...actorFrom(request),
        environmentId: service.environmentId,
      });

      // `success` is deprecated (issue #127); clients should prefer `status`.
      return { results, status, targetsAttempted, targetsSucceeded, targetsFailed, success: allSuccess };
    }
  );

  // Get config file sync status for all services on a server
  fastify.get(
    '/api/servers/:serverId/config-files-status',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };

      const server = await findOrNotFound(
        prisma.server.findUnique({
          where: { id: serverId },
          include: {
            serviceDeployments: {
              include: {
                service: {
                  include: {
                    files: {
                      include: {
                        configFile: {
                          select: { id: true, name: true, filename: true, updatedAt: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        'Server',
        reply
      );
      if (!server) return;

      const configFilesMap = new Map<string, {
        id: string;
        name: string;
        filename: string;
        updatedAt: Date;
        attachments: Array<{
          serviceFileId: string;
          serviceId: string;
          serviceName: string;
          targetPath: string;
          lastSyncedAt: Date | null;
          syncStatus: 'synced' | 'pending' | 'never';
        }>;
      }>();

      // Walk deployments on this server; for each, pick base + override files of the parent template.
      for (const sd of server.serviceDeployments) {
        const filesByConfig = new Map<string, typeof sd.service.files[number]>();
        for (const sf of sd.service.files) {
          if (sf.serviceDeploymentId === sd.id) {
            filesByConfig.set(sf.configFileId, sf);
          } else if (sf.serviceDeploymentId === null && !filesByConfig.has(sf.configFileId)) {
            filesByConfig.set(sf.configFileId, sf);
          }
        }
        for (const sf of filesByConfig.values()) {
          const cf = sf.configFile;
          if (!configFilesMap.has(cf.id)) {
            configFilesMap.set(cf.id, {
              id: cf.id,
              name: cf.name,
              filename: cf.filename,
              updatedAt: cf.updatedAt,
              attachments: [],
            });
          }

          let syncStatus: 'synced' | 'pending' | 'never' = 'never';
          if (sf.lastSyncedAt) {
            syncStatus = new Date(sf.lastSyncedAt) >= new Date(cf.updatedAt) ? 'synced' : 'pending';
          }

          configFilesMap.get(cf.id)!.attachments.push({
            serviceFileId: sf.id,
            serviceId: sd.service.id,
            serviceName: sd.service.name,
            targetPath: sf.targetPath,
            lastSyncedAt: sf.lastSyncedAt,
            syncStatus,
          });
        }
      }

      const configFiles = Array.from(configFilesMap.values()).map((cf) => {
        // Determine overall sync status for this config file on this server
        let overallSyncStatus: 'synced' | 'pending' | 'never' = 'synced';
        for (const att of cf.attachments) {
          if (att.syncStatus === 'never') {
            overallSyncStatus = 'never';
            break;
          } else if (att.syncStatus === 'pending') {
            overallSyncStatus = 'pending';
          }
        }

        return {
          ...cf,
          overallSyncStatus,
        };
      });

      // Count totals
      const totals = {
        synced: configFiles.filter((cf) => cf.overallSyncStatus === 'synced').length,
        pending: configFiles.filter((cf) => cf.overallSyncStatus === 'pending').length,
        never: configFiles.filter((cf) => cf.overallSyncStatus === 'never').length,
        total: configFiles.length,
      };

      return { configFiles, totals };
    }
  );

  // Sync all config files for all services on a server
  fastify.post(
    '/api/servers/:serverId/sync-all-files',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };

      const server = await findOrNotFound(
        prisma.server.findUnique({
          where: { id: serverId },
          include: {
            serviceDeployments: {
              include: {
                service: {
                  include: {
                    files: {
                      include: {
                        configFile: {
                          include: {
                            includedFragments: {
                              include: { fragment: true },
                              orderBy: { position: 'asc' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        'Server',
        reply
      );
      if (!server) return;

      // Resolve effective files per deployment (override -> base) and flatten for syncing.
      type FileTuple = { serviceFile: typeof server.serviceDeployments[0]['service']['files'][0]; service: typeof server.serviceDeployments[0]['service'] };
      const serviceFilesToSync: FileTuple[] = [];

      for (const sd of server.serviceDeployments) {
        const filesByConfig = new Map<string, typeof sd.service.files[number]>();
        for (const sf of sd.service.files) {
          if (sf.serviceDeploymentId === sd.id) {
            filesByConfig.set(sf.configFileId, sf);
          } else if (sf.serviceDeploymentId === null && !filesByConfig.has(sf.configFileId)) {
            filesByConfig.set(sf.configFileId, sf);
          }
        }
        for (const sf of filesByConfig.values()) {
          serviceFilesToSync.push({ serviceFile: sf, service: sd.service });
        }
      }

      // Zero targets → 200 + no_targets (issue #127). Previously returned a 400
      // which the UI surfaced as a red error even though nothing was wrong.
      if (serviceFilesToSync.length === 0) {
        await logAudit({
          action: 'sync_files',
          resourceType: 'server',
          resourceId: server.id,
          resourceName: server.name,
          details: { results: [], status: 'no_targets', reason: 'no_attached_files' },
          success: false,
          ...actorFrom(request),
          environmentId: server.environmentId,
        });
        return {
          results: [],
          status: 'no_targets' as const,
          targetsAttempted: 0,
          targetsSucceeded: 0,
          targetsFailed: 0,
          success: false,
        };
      }

      const results: Array<{
        configFileName: string;
        serviceName: string;
        targetPath: string;
        success: boolean;
        error?: string;
      }> = [];

      // Create SSH connection
      const { client, error: clientError } = await createClientForServer(
        server.hostname,
        server.environmentId,
        getEnvironmentSshKey,
        { serverType: server.serverType }
      );

      if (!client) {
        return reply.code(400).send({ error: clientError || 'Failed to create SSH client' });
      }

      try {
        await client.connect();

        for (const { serviceFile: sf, service } of serviceFilesToSync) {
          const configFile = sf.configFile;

          try {
            // Ensure target directory exists
            const targetDir = sf.targetPath.substring(0, sf.targetPath.lastIndexOf('/'));
            await client.exec(`mkdir -p ${shellEscape(targetDir)}`);

            let code: number;
            let stderr: string;

            if (configFile.isBinary) {
              const fileBuffer = Buffer.from(configFile.content, 'base64');
              try {
                await client.writeFile(sf.targetPath, fileBuffer);
                code = 0;
                stderr = '';
              } catch (writeErr) {
                code = 1;
                stderr = writeErr instanceof Error ? writeErr.message : 'SFTP write failed';
              }
            } else {
              const composedSource = composeFragmentedContent(
                configFile.includedFragments.map((f) => ({
                  name: f.fragment.name,
                  content: f.fragment.content,
                })),
                configFile.content,
                configFile.language,
              );
              const { content: rawContent, missing, templateErrors } = await resolveSecretPlaceholders(
                server.environmentId,
                composedSource
              );
              const resolvedContent = rawContent.trimEnd();

              if (templateErrors.length > 0) {
                results.push({
                  configFileName: configFile.name,
                  serviceName: service.name,
                  targetPath: sf.targetPath,
                  success: false,
                  error: `Template errors: ${templateErrors.join('; ')}`,
                });
                continue;
              }

              if (missing.length > 0) {
                results.push({
                  configFileName: configFile.name,
                  serviceName: service.name,
                  targetPath: sf.targetPath,
                  success: false,
                  error: `Missing secrets: ${missing.join(', ')}`,
                });
                continue;
              }

              ({ code, stderr } = await client.exec(
                `cat > ${shellEscape(sf.targetPath)} << 'CONFIGFILE_EOF'\n${resolvedContent}\nCONFIGFILE_EOF`
              ));
            }

            if (code !== 0) {
              results.push({
                configFileName: configFile.name,
                serviceName: service.name,
                targetPath: sf.targetPath,
                success: false,
                error: stderr || 'Failed to write file',
              });
            } else {
              await prisma.serviceFile.update({
                where: { id: sf.id },
                data: { lastSyncedAt: new Date() },
              });
              results.push({
                configFileName: configFile.name,
                serviceName: service.name,
                targetPath: sf.targetPath,
                success: true,
              });
            }
          } catch (err) {
            results.push({
              configFileName: configFile.name,
              serviceName: service.name,
              targetPath: sf.targetPath,
              success: false,
              error: getErrorMessage(err, 'Unknown error'),
            });
          }
        }
      } catch (error) {
        return reply.code(500).send({ error: getErrorMessage(error, 'Connection failed') });
      } finally {
        client.disconnect();
      }

      const status = deriveSyncStatus(results);
      const targetsAttempted = results.length;
      const targetsSucceeded = results.filter((r) => r.success).length;
      const targetsFailed = targetsAttempted - targetsSucceeded;
      const allSuccess = status === 'ok';

      await logAudit({
        action: 'sync_files',
        resourceType: 'server',
        resourceId: server.id,
        resourceName: server.name,
        details: { results, status, allSuccess, totalFiles: results.length },
        success: allSuccess,
        ...actorFrom(request),
        environmentId: server.environmentId,
      });

      // `success` is deprecated (issue #127); clients should prefer `status`.
      return { results, status, targetsAttempted, targetsSucceeded, targetsFailed, success: allSuccess };
    }
  );

  // Sync a config file to every (service, server) attachment.
  // Now delegates to the shared helper which already handles per-deployment fan-out.
  fastify.post(
    '/api/config-files/:id/sync-all',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      if (isDryRun(request)) {
        const report = await syncConfigFileToAttachedServicesDryRun(id);
        if (!report) {
          return reply.code(404).send({ error: 'Config file not found' });
        }
        // Look up the env for audit attribution. The dry-run helper doesn't
        // return it (it only returns target reports), so fetch it cheaply.
        const cf = await prisma.configFile.findUnique({
          where: { id },
          select: { environmentId: true, name: true },
        });
        await logAudit({
          action: 'sync_files',
          resourceType: 'config_file',
          resourceId: id,
          resourceName: cf?.name ?? id,
          details: { dryRun: true, results: report.results.length },
          ...actorFrom(request),
          environmentId: cf?.environmentId,
        });
        return report;
      }

      const outcome = await syncConfigFileToAttachedServices(id);
      // null = the ConfigFile itself doesn't exist — true 404.
      if (!outcome) {
        return reply.code(404).send({ error: 'Config file not found' });
      }

      await logAudit({
        action: 'sync_files',
        resourceType: 'config_file',
        resourceId: id,
        resourceName: outcome.configFileName,
        details: {
          results: outcome.results,
          status: outcome.status,
          allSuccess: outcome.success,
          syncedTo: outcome.results.length,
        },
        success: outcome.success,
        ...actorFrom(request),
        environmentId: outcome.environmentId,
      });

      // `success` is deprecated (issue #127); clients should prefer `status`.
      return {
        results: outcome.results,
        status: outcome.status,
        targetsAttempted: outcome.targetsAttempted,
        targetsSucceeded: outcome.targetsSucceeded,
        targetsFailed: outcome.targetsFailed,
        success: outcome.success,
      };
    }
  );

  // Upload asset file (binary)
  fastify.post(
    '/api/environments/:envId/asset-files/upload',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };

      // Check environment exists
      const environment = await findOrNotFound(prisma.environment.findUnique({ where: { id: envId } }), 'Environment', reply);
      if (!environment) return;

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
        // Wrap content write + usage sync in a transaction so both commit or
        // roll back together. (For binary assets the helper no-ops, but the
        // transaction keeps the contract consistent with the other paths.)
        const configFile = await prisma.$transaction(async (tx) => {
          const cf = await tx.configFile.create({
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
          // Binary assets produce no usage; the helper still no-ops cleanly so
          // we call it for consistency with the other write paths.
          await syncUsageForConfigFile(tx, cf);
          return cf;
        });

        await logAudit({
          action: 'create',
          resourceType: 'config_file',
          resourceId: configFile.id,
          resourceName: configFile.name,
          details: { isBinary: true, mimeType, fileSize },
          ...actorFrom(request),
          environmentId: envId,
        });

        // Strip binary content from response — no need to echo back the base64 payload
        return { configFile: { ...configFile, content: '' } };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Config file with this name already exists', reply)) return;
        throw error;
      }
    }
  );
}
