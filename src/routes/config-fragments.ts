import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { logAudit, actorFrom } from '../services/audit.js';
import {
  validateBody,
  validateUpdateBody,
  findOrNotFound,
  handleUniqueConstraint,
  parsePaginationQuery,
} from '../lib/helpers.js';
import { triggerAutoResyncForFragment } from '../services/config-file-auto-resync.js';

const createFragmentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
});

const updateFragmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  content: z.string().optional(),
});

/**
 * Env-scoped CRUD for ConfigFragment — named, reusable text blocks that
 * ConfigFiles can include. See `prisma/schema.prisma` (ConfigFragment) and
 * `src/lib/config-fragments.ts` (compose helper) for the data model and
 * render contract.
 *
 * Delete is blocked when the fragment is referenced by any ConfigFile —
 * surfaced as 409 with `details.inUseBy: [{configFileId, configFileName,
 * serviceId, serviceName}]` so the UI can show "in use by" rather than
 * failing silently. The `details` envelope field is the codebase
 * convention for structured error payloads — it survives the legacy
 * `{error}` reshape in `src/plugins/error-handler.ts` for <500 statuses.
 */
export async function configFragmentRoutes(fastify: FastifyInstance): Promise<void> {
  // List fragments for environment. Paginated because fragments can carry
  // large `content` bodies; an unbounded list grows linearly with adoption.
  fastify.get(
    '/api/environments/:envId/config-fragments',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit, offset } = parsePaginationQuery(
        request.query as Record<string, unknown>
      );
      const where = { environmentId: envId };

      const [fragments, total] = await Promise.all([
        prisma.configFragment.findMany({
          where,
          orderBy: { name: 'asc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            name: true,
            description: true,
            content: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { configFiles: true } },
          },
        }),
        prisma.configFragment.count({ where }),
      ]);

      // Shape `usedByCount` so the UI can show "in use by N ConfigFiles"
      // without exposing the Prisma `_count` quirk.
      const shaped = fragments.map((f) => {
        const { _count, ...rest } = f;
        return { ...rest, usedByCount: _count.configFiles };
      });

      return { fragments: shaped, total, limit, offset };
    }
  );

  // Get a single fragment
  fastify.get(
    '/api/config-fragments/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const fragment = await findOrNotFound(
        prisma.configFragment.findUnique({
          where: { id },
          include: {
            configFiles: {
              orderBy: { position: 'asc' },
              include: {
                configFile: {
                  select: {
                    id: true,
                    name: true,
                    filename: true,
                    services: {
                      select: {
                        service: { select: { id: true, name: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        'Config fragment',
        reply
      );
      if (!fragment) return;

      // Flatten the "where is this used" list for the UI.
      const usedBy = fragment.configFiles.map((row) => ({
        configFileId: row.configFile.id,
        configFileName: row.configFile.name,
        configFileFilename: row.configFile.filename,
        position: row.position,
        services: row.configFile.services.map((sf) => ({
          serviceId: sf.service.id,
          serviceName: sf.service.name,
        })),
      }));

      const { configFiles: _unused, ...rest } = fragment;
      void _unused;
      return { fragment: { ...rest, usedBy } };
    }
  );

  // Create fragment
  fastify.post(
    '/api/environments/:envId/config-fragments',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createFragmentSchema, request, reply);
      if (!body) return;

      try {
        const fragment = await prisma.configFragment.create({
          data: { ...body, environmentId: envId },
        });

        await logAudit({
          action: 'create',
          resourceType: 'config_fragment',
          resourceId: fragment.id,
          resourceName: fragment.name,
          ...actorFrom(request),
          environmentId: envId,
        });

        return { fragment };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Fragment with this name already exists', reply)) return;
        throw error;
      }
    }
  );

  // Update fragment
  fastify.patch(
    '/api/config-fragments/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateUpdateBody(updateFragmentSchema, 'configFragment', request, reply);
      if (!body) return;

      try {
        const existing = await findOrNotFound(
          prisma.configFragment.findUnique({ where: { id } }),
          'Config fragment',
          reply
        );
        if (!existing) return;

        const fragment = await prisma.configFragment.update({
          where: { id },
          data: body,
        });

        await logAudit({
          action: 'update',
          resourceType: 'config_fragment',
          resourceId: fragment.id,
          resourceName: fragment.name,
          ...actorFrom(request),
          environmentId: existing.environmentId,
        });

        // Fragment content changed → fan out an auto-resync to every
        // ConfigFile that includes this fragment (autoResync=true rows
        // only). Fire-and-forget; mirror of the ${KEY} auto-resync path.
        if (body.content !== undefined && body.content !== existing.content) {
          void triggerAutoResyncForFragment(fragment.id, fragment.name, actorFrom(request));
        }

        return { fragment };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Fragment with this name already exists', reply)) return;
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Config fragment not found' });
        }
        throw error;
      }
    }
  );

  // Delete fragment (blocked when in use)
  fastify.delete(
    '/api/config-fragments/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const fragment = await prisma.configFragment.findUnique({
        where: { id },
        include: {
          configFiles: {
            include: {
              configFile: {
                select: {
                  id: true,
                  name: true,
                  services: { select: { service: { select: { id: true, name: true } } } },
                },
              },
            },
          },
        },
      });
      if (!fragment) {
        return reply.code(404).send({ error: 'Config fragment not found' });
      }

      if (fragment.configFiles.length > 0) {
        // Build the "in use by" list with one entry per (configFile,
        // serviceAttachment) pair — matches the issue contract for the 409
        // body so the UI can render exactly which services would be
        // affected.
        type InUseRow = {
          configFileId: string;
          configFileName: string;
          serviceId: string | null;
          serviceName: string | null;
        };
        const inUseBy: InUseRow[] = fragment.configFiles.flatMap((row): InUseRow[] => {
          if (row.configFile.services.length === 0) {
            // ConfigFile exists but isn't attached to any service yet —
            // still blocks deletion (the include is wired up). Surface
            // with null serviceId/serviceName so the UI can show the
            // ConfigFile as "unattached".
            return [{
              configFileId: row.configFile.id,
              configFileName: row.configFile.name,
              serviceId: null,
              serviceName: null,
            }];
          }
          return row.configFile.services.map((sf): InUseRow => ({
            configFileId: row.configFile.id,
            configFileName: row.configFile.name,
            serviceId: sf.service.id,
            serviceName: sf.service.name,
          }));
        });

        // Nest the structured payload under `details` so the global
        // legacy-shape reshape hook in src/plugins/error-handler.ts
        // preserves it on the wire as `{code, message, details: {inUseBy}}`.
        // Flat `inUseBy` at the envelope level would be stripped.
        return reply.code(409).send({
          error: 'Fragment is in use and cannot be deleted',
          details: { inUseBy },
        });
      }

      await prisma.configFragment.delete({ where: { id } });

      await logAudit({
        action: 'delete',
        resourceType: 'config_fragment',
        resourceId: id,
        resourceName: fragment.name,
        ...actorFrom(request),
        environmentId: fragment.environmentId,
      });

      return { success: true };
    }
  );
}
