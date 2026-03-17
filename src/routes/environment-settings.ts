import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import { prisma } from '../lib/db.js';
import {
  getModuleSettings,
  updateModuleSettings,
  resetModuleSettings,
  SETTINGS_REGISTRY,
  type SettingsModule,
} from '../services/environment-settings.js';
import { findOrNotFound, getErrorMessage } from '../lib/helpers.js';

const VALID_MODULES = ['general', 'monitoring', 'operations', 'data', 'configuration'] as const;

function isValidModule(value: string): value is SettingsModule {
  return (VALID_MODULES as readonly string[]).includes(value);
}

export async function environmentSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/environments/:id/settings/registry
  fastify.get(
    '/api/environments/:id/settings/registry',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      return { registry: SETTINGS_REGISTRY };
    },
  );

  // GET /api/environments/:id/settings/:module
  fastify.get(
    '/api/environments/:id/settings/:module',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const settings = await getModuleSettings(id, module);
      const definitions = SETTINGS_REGISTRY[module];

      return { settings, definitions };
    },
  );

  // PATCH /api/environments/:id/settings/:module
  fastify.patch(
    '/api/environments/:id/settings/:module',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      try {
        const { updated, changes } = await updateModuleSettings(id, module, request.body as Record<string, unknown>);

        if (changes.length > 0) {
          await logAudit({
            action: 'update',
            resourceType: 'environment',
            resourceId: id,
            resourceName: env.name,
            details: { module, changes },
            userId: request.authUser!.id,
            environmentId: id,
          });
        }

        return { settings: updated };
      } catch (err) {
        const message = getErrorMessage(err, 'Validation failed');
        return reply.code(400).send({ error: message });
      }
    },
  );

  // POST /api/environments/:id/settings/:module/reset
  fastify.post(
    '/api/environments/:id/settings/:module/reset',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, module } = request.params as { id: string; module: string };

      if (!isValidModule(module)) {
        return reply.code(400).send({ error: `Invalid module: ${module}. Must be one of: ${VALID_MODULES.join(', ')}` });
      }

      const env = await findOrNotFound(prisma.environment.findUnique({ where: { id } }), 'Environment', reply);
      if (!env) return;

      const settings = await resetModuleSettings(id, module);

      await logAudit({
        action: 'update',
        resourceType: 'environment',
        resourceId: id,
        resourceName: env.name,
        details: { module, reset: true },
        userId: request.authUser!.id,
        environmentId: id,
      });

      return { settings };
    },
  );
}
