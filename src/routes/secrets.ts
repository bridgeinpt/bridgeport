import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import {
  createSecret,
  updateSecret,
  getSecretValue,
  listSecrets,
  deleteSecret,
} from '../services/secrets.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { validateBody, validateUpdateBody, findOrNotFound, handleUniqueConstraint } from '../lib/helpers.js';
import { requireOperator } from '../plugins/authorize.js';
import { triggerAutoResyncForKey } from '../services/config-file-auto-resync.js';

const createSecretSchema = z.object({
  key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase with underscores'),
  value: z.string().min(1),
  description: z.string().optional(),
  neverReveal: z.boolean().optional().default(false),
});

const updateSecretSchema = z.object({
  value: z.string().min(1).optional(),
  description: z.string().optional(),
  neverReveal: z.boolean().optional(),
});

const createVarSchema = z.object({
  key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase with underscores'),
  value: z.string().min(1),
  description: z.string().optional(),
});

const updateVarSchema = z.object({
  value: z.string().min(1).optional(),
  description: z.string().optional(),
});

export async function secretRoutes(fastify: FastifyInstance): Promise<void> {
  // List secrets (without values) with usage information.
  //
  // Usage is resolved via the SecretUsage join table (maintained on every
  // ConfigFile content write) — replaces the previous per-content regex scan
  // that was O(secrets × configFiles × content size).
  fastify.get(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const secrets = await listSecrets(envId);

      const usages = await prisma.secretUsage.findMany({
        where: { environmentId: envId, secretKey: { in: secrets.map((s) => s.key) } },
        select: {
          secretKey: true,
          configFile: {
            select: {
              id: true,
              name: true,
              filename: true,
              services: {
                select: {
                  service: {
                    select: {
                      id: true,
                      name: true,
                      serviceDeployments: { select: { server: { select: { id: true, name: true } } } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Group rows by secretKey so we can attach them to the matching secret
      // when building the response — preserves the prior `usedByConfigFiles`
      // / `usedByServices` / `usageCount` shape exactly.
      const usagesByKey = new Map<string, typeof usages>();
      for (const row of usages) {
        const list = usagesByKey.get(row.secretKey);
        if (list) list.push(row);
        else usagesByKey.set(row.secretKey, [row]);
      }

      const secretsWithUsage = secrets.map((secret) => {
        const rows = usagesByKey.get(secret.key) ?? [];

        const usedByConfigFiles = rows.map((row) => ({
          id: row.configFile.id,
          name: row.configFile.name,
          filename: row.configFile.filename,
          services: row.configFile.services.flatMap((sf) =>
            sf.service.serviceDeployments.map((sd) => ({
              id: sf.service.id,
              name: sf.service.name,
              serverName: sd.server.name,
            }))
          ),
        }));

        // Derive unique services that use this secret
        const usedByServices = new Map<string, { id: string; name: string; serverName: string }>();
        for (const file of usedByConfigFiles) {
          for (const service of file.services) {
            if (!usedByServices.has(service.id)) {
              usedByServices.set(service.id, service);
            }
          }
        }

        return {
          ...secret,
          usedByConfigFiles,
          usedByServices: Array.from(usedByServices.values()),
          usageCount: usedByServices.size,
        };
      });

      return { secrets: secretsWithUsage };
    }
  );

  // Create secret
  fastify.post(
    '/api/environments/:envId/secrets',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createSecretSchema, request, reply);
      if (!body) return;

      try {
        const secret = await createSecret(envId, body);

        await logAudit({
          action: 'create',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          ...actorFrom(request),
          environmentId: envId,
        });

        return { secret };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Secret already exists', reply)) return;
        throw error;
      }
    }
  );

  // Get secret value (requires explicit action)
  fastify.get(
    '/api/secrets/:id/value',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await findOrNotFound(prisma.secret.findUnique({ where: { id } }), 'Secret', reply);
        if (!secret) return;

        // Check environment-level reveal setting
        const configSettings = await prisma.configurationSettings.findUnique({
          where: { environmentId: secret.environmentId },
        });
        if (configSettings && !configSettings.allowSecretReveal) {
          await logAudit({
            action: 'access',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            details: { blocked: true, reason: 'environment_disabled' },
            success: false,
            error: 'Secret reveal disabled for this environment',
            ...actorFrom(request),
            environmentId: secret.environmentId,
          });
          return reply.code(403).send({ error: 'Secret reveal is disabled for this environment' });
        }

        // Check secret-level reveal setting
        if (secret.neverReveal) {
          await logAudit({
            action: 'access',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            details: { blocked: true, reason: 'write_only' },
            success: false,
            error: 'This secret is write-only',
            ...actorFrom(request),
            environmentId: secret.environmentId,
          });
          return reply.code(403).send({ error: 'This secret is write-only and cannot be revealed' });
        }

        const value = await getSecretValue(id);

        await logAudit({
          action: 'access',
          resourceType: 'secret',
          resourceId: id,
          resourceName: secret.key,
          ...actorFrom(request),
          environmentId: secret.environmentId,
        });

        return { value };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Update secret
  fastify.patch(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Rejects PATCH of derived/encrypted-storage fields (key, encryptedValue,
      // nonce) atomically — see src/lib/readonly-fields.ts.
      const body = validateUpdateBody(updateSecretSchema, 'secret', request, reply);
      if (!body) return;

      try {
        const existing = await prisma.secret.findUnique({ where: { id } });

        // Detect whether the secret VALUE actually changed (vs. just metadata).
        // We decrypt the previous value to compare; metadata-only updates skip
        // the auto-resync trigger.
        let valueActuallyChanged = false;
        if (existing && body.value !== undefined) {
          try {
            const previousValue = await getSecretValue(id);
            valueActuallyChanged = previousValue !== body.value;
          } catch {
            // If decryption fails (corrupted record / missing key), assume the
            // value changed so we err on the side of triggering a resync.
            valueActuallyChanged = true;
          }
        }

        const secret = await updateSecret(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'secret',
          resourceId: secret.id,
          resourceName: secret.key,
          details: { valueChanged: !!body.value, descriptionChanged: !!body.description },
          ...actorFrom(request),
          environmentId: existing?.environmentId,
        });

        if (valueActuallyChanged && existing) {
          // Fire-and-forget: don't block the PATCH response. Errors are logged
          // inside the trigger (and by the catch below as a safety net).
          void triggerAutoResyncForKey(
            existing.environmentId,
            secret.key,
            `secret:${secret.key}:patch`,
            actorFrom(request)
          ).catch((err) => {
            console.error('[auto-resync] failed for secret patch:', err);
          });
        }

        return { secret };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // Delete secret
  fastify.delete(
    '/api/secrets/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const secret = await prisma.secret.findUnique({ where: { id } });
        await deleteSecret(id);

        if (secret) {
          await logAudit({
            action: 'delete',
            resourceType: 'secret',
            resourceId: id,
            resourceName: secret.key,
            ...actorFrom(request),
            environmentId: secret.environmentId,
          });
        }

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Secret not found' });
      }
    }
  );

  // ── Var endpoints ──────────────────────────────────────────────────────

  // List vars with usage information.
  //
  // Mirrors the secrets list: usage is resolved via the VarUsage join table
  // instead of re-scanning every ConfigFile's content per request.
  fastify.get(
    '/api/environments/:envId/vars',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const vars = await prisma.var.findMany({
        where: { environmentId: envId },
        select: {
          id: true,
          key: true,
          value: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { key: 'asc' },
      });

      const usages = await prisma.varUsage.findMany({
        where: { environmentId: envId, varKey: { in: vars.map((v) => v.key) } },
        select: {
          varKey: true,
          configFile: {
            select: {
              id: true,
              name: true,
              filename: true,
              services: {
                select: {
                  service: {
                    select: {
                      id: true,
                      name: true,
                      serviceDeployments: { select: { server: { select: { id: true, name: true } } } },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const usagesByKey = new Map<string, typeof usages>();
      for (const row of usages) {
        const list = usagesByKey.get(row.varKey);
        if (list) list.push(row);
        else usagesByKey.set(row.varKey, [row]);
      }

      const varsWithUsage = vars.map((v) => {
        const rows = usagesByKey.get(v.key) ?? [];

        const usedByConfigFiles = rows.map((row) => ({
          id: row.configFile.id,
          name: row.configFile.name,
          filename: row.configFile.filename,
          services: row.configFile.services.flatMap((sf) =>
            sf.service.serviceDeployments.map((sd) => ({
              id: sf.service.id,
              name: sf.service.name,
              serverName: sd.server.name,
            }))
          ),
        }));

        const usedByServices = new Map<string, { id: string; name: string; serverName: string }>();
        for (const file of usedByConfigFiles) {
          for (const service of file.services) {
            if (!usedByServices.has(service.id)) {
              usedByServices.set(service.id, service);
            }
          }
        }

        return {
          ...v,
          usedByConfigFiles,
          usedByServices: Array.from(usedByServices.values()),
          usageCount: usedByServices.size,
        };
      });

      return { vars: varsWithUsage };
    }
  );

  // Create var
  fastify.post(
    '/api/environments/:envId/vars',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createVarSchema, request, reply);
      if (!body) return;

      try {
        const v = await prisma.var.create({
          data: {
            key: body.key,
            value: body.value,
            description: body.description,
            environmentId: envId,
          },
          select: {
            id: true,
            key: true,
            value: true,
            description: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'var',
          resourceId: v.id,
          resourceName: v.key,
          ...actorFrom(request),
          environmentId: envId,
        });

        return { var: v };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Var already exists', reply)) return;
        throw error;
      }
    }
  );

  // Update var
  fastify.patch(
    '/api/vars/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateVarSchema, request, reply);
      if (!body) return;

      try {
        const existing = await findOrNotFound(prisma.var.findUnique({ where: { id } }), 'Var', reply);
        if (!existing) return;

        const updateData: { value?: string; description?: string } = {};
        if (body.value !== undefined) updateData.value = body.value;
        if (body.description !== undefined) updateData.description = body.description;

        const valueActuallyChanged =
          body.value !== undefined && body.value !== existing.value;

        const v = await prisma.var.update({
          where: { id },
          data: updateData,
          select: {
            id: true,
            key: true,
            value: true,
            description: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await logAudit({
          action: 'update',
          resourceType: 'var',
          resourceId: v.id,
          resourceName: v.key,
          details: { valueChanged: !!body.value, descriptionChanged: !!body.description },
          ...actorFrom(request),
          environmentId: existing.environmentId,
        });

        if (valueActuallyChanged) {
          // Fire-and-forget: don't block the PATCH response. Errors are logged
          // inside the trigger (and by the catch below as a safety net).
          void triggerAutoResyncForKey(
            existing.environmentId,
            v.key,
            `var:${v.key}:patch`,
            actorFrom(request)
          ).catch((err) => {
            console.error('[auto-resync] failed for var patch:', err);
          });
        }

        return { var: v };
      } catch {
        return reply.code(404).send({ error: 'Var not found' });
      }
    }
  );

  // Delete var
  fastify.delete(
    '/api/vars/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const v = await findOrNotFound(prisma.var.findUnique({ where: { id } }), 'Var', reply);
        if (!v) return;

        // Clear VarUsage rows keyed by the (environmentId, key) pair before
        // deleting the Var. Usage rows reference the textual key (not a Var
        // FK), so a stale row would otherwise resurface if a new Var with
        // the same key were created later.
        await prisma.$transaction(async (tx) => {
          await tx.varUsage.deleteMany({
            where: { environmentId: v.environmentId, varKey: v.key },
          });
          await tx.var.delete({ where: { id } });
        });

        await logAudit({
          action: 'delete',
          resourceType: 'var',
          resourceId: id,
          resourceName: v.key,
          ...actorFrom(request),
          environmentId: v.environmentId,
        });

        return { success: true };
      } catch {
        return reply.code(404).send({ error: 'Var not found' });
      }
    }
  );
}
