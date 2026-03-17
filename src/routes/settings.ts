import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import { safeJsonParse, validateBody, findOrNotFound } from '../lib/helpers.js';
import { resetTypeToDefaults, exportTypeAsJson, getLastSyncResult } from '../services/plugin-loader.js';

const createServiceTypeSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(100),
});

const updateServiceTypeSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
});

const createCommandSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(100),
  command: z.string().min(1),
  description: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const updateCommandSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  command: z.string().min(1).optional(),
  description: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const createDatabaseTypeSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(100),
  connectionFields: z.array(z.object({
    name: z.string(),
    label: z.string(),
    type: z.enum(['text', 'number', 'password']),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })),
  backupCommand: z.string().optional(),
  restoreCommand: z.string().optional(),
  defaultPort: z.number().int().optional(),
});

const updateDatabaseTypeSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  connectionFields: z.array(z.object({
    name: z.string(),
    label: z.string(),
    type: z.enum(['text', 'number', 'password']),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })).optional(),
  backupCommand: z.string().nullable().optional(),
  restoreCommand: z.string().nullable().optional(),
  defaultPort: z.number().int().nullable().optional(),
});

/** Mark a service type as customized if it was sourced from a plugin */
async function markServiceTypeCustomized(id: string): Promise<void> {
  const type = await prisma.serviceType.findUnique({ where: { id }, select: { source: true } });
  if (type?.source === 'plugin') {
    await prisma.serviceType.update({ where: { id }, data: { isCustomized: true } });
  }
}

/** Mark a database type as customized if it was sourced from a plugin */
async function markDatabaseTypeCustomized(id: string): Promise<void> {
  const type = await prisma.databaseType.findUnique({ where: { id }, select: { source: true } });
  if (type?.source === 'plugin') {
    await prisma.databaseType.update({ where: { id }, data: { isCustomized: true } });
  }
}

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  // ==================== Plugin Sync Status ====================

  fastify.get(
    '/api/settings/plugin-sync-status',
    { preHandler: [fastify.authenticate] },
    async () => {
      return { syncResult: getLastSyncResult() };
    }
  );

  // ==================== Service Types ====================

  // List all service types with their commands
  fastify.get(
    '/api/settings/service-types',
    { preHandler: [fastify.authenticate] },
    async () => {
      const serviceTypes = await prisma.serviceType.findMany({
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { services: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      return { serviceTypes };
    }
  );

  // Get a single service type
  fastify.get(
    '/api/settings/service-types/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const serviceType = await findOrNotFound(prisma.serviceType.findUnique({
        where: { id },
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { services: true },
          },
        },
      }), 'Service type', reply);
      if (!serviceType) return;

      return { serviceType };
    }
  );

  // Create a service type (admin only)
  fastify.post(
    '/api/settings/service-types',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = validateBody(createServiceTypeSchema, request, reply);
      if (!body) return;

      const existing = await prisma.serviceType.findUnique({
        where: { name: body.name },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Service type already exists' });
      }

      const serviceType = await prisma.serviceType.create({
        data: {
          ...body,
          source: 'user',
        },
        include: {
          commands: true,
        },
      });

      await logAudit({
        action: 'create',
        resourceType: 'service_type',
        resourceId: serviceType.id,
        resourceName: serviceType.name,
        userId: request.authUser!.id,
      });

      return { serviceType };
    }
  );

  // Update a service type (admin only)
  fastify.patch(
    '/api/settings/service-types/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateServiceTypeSchema, request, reply);
      if (!body) return;

      const existing = await findOrNotFound(prisma.serviceType.findUnique({ where: { id } }), 'Service type', reply);
      if (!existing) return;

      await markServiceTypeCustomized(id);

      const serviceType = await prisma.serviceType.update({
        where: { id },
        data: body,
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'service_type',
        resourceId: serviceType.id,
        resourceName: serviceType.name,
        details: body,
        userId: request.authUser!.id,
      });

      return { serviceType };
    }
  );

  // Delete a service type (admin only)
  fastify.delete(
    '/api/settings/service-types/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await findOrNotFound(prisma.serviceType.findUnique({
        where: { id },
        include: { _count: { select: { services: true } } },
      }), 'Service type', reply);
      if (!existing) return;

      if (existing._count.services > 0) {
        return reply.code(409).send({
          error: 'Cannot delete service type that is in use',
          servicesCount: existing._count.services,
        });
      }

      await prisma.serviceType.delete({ where: { id } });

      await logAudit({
        action: 'delete',
        resourceType: 'service_type',
        resourceId: id,
        resourceName: existing.name,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Reset service type to plugin defaults (admin only)
  fastify.post(
    '/api/settings/service-types/:id/reset',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await findOrNotFound(prisma.serviceType.findUnique({ where: { id } }), 'Service type', reply);
      if (!existing) return;

      const success = await resetTypeToDefaults('service-type', id);
      if (!success) {
        return reply.code(400).send({ error: 'No plugin file found for this type' });
      }

      await logAudit({
        action: 'update',
        resourceType: 'service_type',
        resourceId: id,
        resourceName: existing.name,
        details: { action: 'reset_to_defaults' },
        userId: request.authUser!.id,
      });

      const serviceType = await prisma.serviceType.findUnique({
        where: { id },
        include: { commands: { orderBy: { sortOrder: 'asc' } } },
      });

      return { serviceType };
    }
  );

  // Export service type as JSON (admin only)
  fastify.post(
    '/api/settings/service-types/:id/export',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await exportTypeAsJson('service-type', id);
      if (!result.written) {
        return reply.code(400).send({ error: result.error || 'Export failed' });
      }

      return { success: true };
    }
  );

  // ==================== Service Type Commands ====================

  // Add a command to a service type (admin only)
  fastify.post(
    '/api/settings/service-types/:id/commands',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(createCommandSchema, request, reply);
      if (!body) return;

      const serviceType = await findOrNotFound(prisma.serviceType.findUnique({ where: { id } }), 'Service type', reply);
      if (!serviceType) return;

      // Check for duplicate command name
      const existingCmd = await prisma.serviceTypeCommand.findUnique({
        where: {
          serviceTypeId_name: { serviceTypeId: id, name: body.name },
        },
      });

      if (existingCmd) {
        return reply.code(409).send({ error: 'Command already exists' });
      }

      // Get max sortOrder if not specified
      let sortOrder = body.sortOrder;
      if (sortOrder === undefined) {
        const maxOrder = await prisma.serviceTypeCommand.findFirst({
          where: { serviceTypeId: id },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        sortOrder = (maxOrder?.sortOrder ?? -1) + 1;
      }

      const command = await prisma.serviceTypeCommand.create({
        data: {
          ...body,
          sortOrder,
          serviceTypeId: id,
        },
      });

      await markServiceTypeCustomized(id);

      await logAudit({
        action: 'create',
        resourceType: 'service_type_command',
        resourceId: command.id,
        resourceName: `${serviceType.name}/${command.name}`,
        details: { serviceTypeId: id, command: body.command },
        userId: request.authUser!.id,
      });

      return { command };
    }
  );

  // Update a command (admin only)
  fastify.patch(
    '/api/settings/service-types/:id/commands/:commandId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, commandId } = request.params as { id: string; commandId: string };
      const body = validateBody(updateCommandSchema, request, reply);
      if (!body) return;

      const existing = await findOrNotFound(prisma.serviceTypeCommand.findFirst({
        where: { id: commandId, serviceTypeId: id },
        include: { serviceType: true },
      }), 'Command', reply);
      if (!existing) return;

      const command = await prisma.serviceTypeCommand.update({
        where: { id: commandId },
        data: body,
      });

      await markServiceTypeCustomized(id);

      await logAudit({
        action: 'update',
        resourceType: 'service_type_command',
        resourceId: command.id,
        resourceName: `${existing.serviceType.name}/${command.name}`,
        details: body,
        userId: request.authUser!.id,
      });

      return { command };
    }
  );

  // Delete a command (admin only)
  fastify.delete(
    '/api/settings/service-types/:id/commands/:commandId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, commandId } = request.params as { id: string; commandId: string };

      const existing = await findOrNotFound(prisma.serviceTypeCommand.findFirst({
        where: { id: commandId, serviceTypeId: id },
        include: { serviceType: true },
      }), 'Command', reply);
      if (!existing) return;

      await prisma.serviceTypeCommand.delete({ where: { id: commandId } });

      await markServiceTypeCustomized(id);

      await logAudit({
        action: 'delete',
        resourceType: 'service_type_command',
        resourceId: commandId,
        resourceName: `${existing.serviceType.name}/${existing.name}`,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Reorder commands (admin only)
  fastify.put(
    '/api/settings/service-types/:id/commands/reorder',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.array(z.string()).safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input - expected array of command IDs' });
      }

      const serviceType = await findOrNotFound(prisma.serviceType.findUnique({ where: { id } }), 'Service type', reply);
      if (!serviceType) return;

      // Update sortOrder for each command
      await Promise.all(
        body.data.map((commandId, index) =>
          prisma.serviceTypeCommand.updateMany({
            where: { id: commandId, serviceTypeId: id },
            data: { sortOrder: index },
          })
        )
      );

      const commands = await prisma.serviceTypeCommand.findMany({
        where: { serviceTypeId: id },
        orderBy: { sortOrder: 'asc' },
      });

      return { commands };
    }
  );

  // ==================== Database Types ====================

  // List all database types with their commands
  fastify.get(
    '/api/settings/database-types',
    { preHandler: [fastify.authenticate] },
    async () => {
      const databaseTypes = await prisma.databaseType.findMany({
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { databases: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      return {
        databaseTypes: databaseTypes.map(dt => ({
          ...dt,
          connectionFields: safeJsonParse(dt.connectionFields, []),
        })),
      };
    }
  );

  // Get a single database type
  fastify.get(
    '/api/settings/database-types/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const databaseType = await findOrNotFound(prisma.databaseType.findUnique({
        where: { id },
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { databases: true },
          },
        },
      }), 'Database type', reply);
      if (!databaseType) return;

      return {
        databaseType: {
          ...databaseType,
          connectionFields: safeJsonParse(databaseType.connectionFields, []),
        },
      };
    }
  );

  // Create a database type (admin only)
  fastify.post(
    '/api/settings/database-types',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = validateBody(createDatabaseTypeSchema, request, reply);
      if (!body) return;

      const existing = await prisma.databaseType.findUnique({
        where: { name: body.name },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Database type already exists' });
      }

      const databaseType = await prisma.databaseType.create({
        data: {
          name: body.name,
          displayName: body.displayName,
          source: 'user',
          connectionFields: JSON.stringify(body.connectionFields),
          backupCommand: body.backupCommand || null,
          restoreCommand: body.restoreCommand || null,
          defaultPort: body.defaultPort || null,
        },
        include: {
          commands: true,
        },
      });

      await logAudit({
        action: 'create',
        resourceType: 'database_type',
        resourceId: databaseType.id,
        resourceName: databaseType.name,
        userId: request.authUser!.id,
      });

      return {
        databaseType: {
          ...databaseType,
          connectionFields: safeJsonParse(databaseType.connectionFields, []),
        },
      };
    }
  );

  // Update a database type (admin only)
  fastify.patch(
    '/api/settings/database-types/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateDatabaseTypeSchema, request, reply);
      if (!body) return;

      const existing = await findOrNotFound(prisma.databaseType.findUnique({ where: { id } }), 'Database type', reply);
      if (!existing) return;

      await markDatabaseTypeCustomized(id);

      const updateData: Record<string, unknown> = {};
      if (body.displayName !== undefined) updateData.displayName = body.displayName;
      if (body.connectionFields !== undefined) updateData.connectionFields = JSON.stringify(body.connectionFields);
      if (body.backupCommand !== undefined) updateData.backupCommand = body.backupCommand;
      if (body.restoreCommand !== undefined) updateData.restoreCommand = body.restoreCommand;
      if (body.defaultPort !== undefined) updateData.defaultPort = body.defaultPort;

      const databaseType = await prisma.databaseType.update({
        where: { id },
        data: updateData,
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'database_type',
        resourceId: databaseType.id,
        resourceName: databaseType.name,
        details: body,
        userId: request.authUser!.id,
      });

      return {
        databaseType: {
          ...databaseType,
          connectionFields: safeJsonParse(databaseType.connectionFields, []),
        },
      };
    }
  );

  // Delete a database type (admin only)
  fastify.delete(
    '/api/settings/database-types/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await findOrNotFound(prisma.databaseType.findUnique({
        where: { id },
        include: { _count: { select: { databases: true } } },
      }), 'Database type', reply);
      if (!existing) return;

      if (existing._count.databases > 0) {
        return reply.code(409).send({
          error: 'Cannot delete database type that is in use',
          databasesCount: existing._count.databases,
        });
      }

      await prisma.databaseType.delete({ where: { id } });

      await logAudit({
        action: 'delete',
        resourceType: 'database_type',
        resourceId: id,
        resourceName: existing.name,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Reset database type to plugin defaults (admin only)
  fastify.post(
    '/api/settings/database-types/:id/reset',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await findOrNotFound(prisma.databaseType.findUnique({ where: { id } }), 'Database type', reply);
      if (!existing) return;

      const success = await resetTypeToDefaults('database-type', id);
      if (!success) {
        return reply.code(400).send({ error: 'No plugin file found for this type' });
      }

      await logAudit({
        action: 'update',
        resourceType: 'database_type',
        resourceId: id,
        resourceName: existing.name,
        details: { action: 'reset_to_defaults' },
        userId: request.authUser!.id,
      });

      const databaseType = await prisma.databaseType.findUnique({
        where: { id },
        include: { commands: { orderBy: { sortOrder: 'asc' } } },
      });

      return {
        databaseType: databaseType ? {
          ...databaseType,
          connectionFields: safeJsonParse(databaseType.connectionFields, []),
        } : null,
      };
    }
  );

  // Export database type as JSON (admin only)
  fastify.post(
    '/api/settings/database-types/:id/export',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const result = await exportTypeAsJson('database-type', id);
      if (!result.written) {
        return reply.code(400).send({ error: result.error || 'Export failed' });
      }

      return { success: true };
    }
  );

  // ==================== Database Type Commands ====================

  // Add a command to a database type (admin only)
  fastify.post(
    '/api/settings/database-types/:id/commands',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(createCommandSchema, request, reply);
      if (!body) return;

      const databaseType = await findOrNotFound(prisma.databaseType.findUnique({ where: { id } }), 'Database type', reply);
      if (!databaseType) return;

      const existingCmd = await prisma.databaseTypeCommand.findUnique({
        where: {
          databaseTypeId_name: { databaseTypeId: id, name: body.name },
        },
      });

      if (existingCmd) {
        return reply.code(409).send({ error: 'Command already exists' });
      }

      let sortOrder = body.sortOrder;
      if (sortOrder === undefined) {
        const maxOrder = await prisma.databaseTypeCommand.findFirst({
          where: { databaseTypeId: id },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        sortOrder = (maxOrder?.sortOrder ?? -1) + 1;
      }

      const command = await prisma.databaseTypeCommand.create({
        data: {
          ...body,
          sortOrder,
          databaseTypeId: id,
        },
      });

      await markDatabaseTypeCustomized(id);

      await logAudit({
        action: 'create',
        resourceType: 'database_type_command',
        resourceId: command.id,
        resourceName: `${databaseType.name}/${command.name}`,
        details: { databaseTypeId: id, command: body.command },
        userId: request.authUser!.id,
      });

      return { command };
    }
  );

  // Update a database type command (admin only)
  fastify.patch(
    '/api/settings/database-types/:id/commands/:commandId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, commandId } = request.params as { id: string; commandId: string };
      const body = validateBody(updateCommandSchema, request, reply);
      if (!body) return;

      const existing = await findOrNotFound(prisma.databaseTypeCommand.findFirst({
        where: { id: commandId, databaseTypeId: id },
        include: { databaseType: true },
      }), 'Command', reply);
      if (!existing) return;

      const command = await prisma.databaseTypeCommand.update({
        where: { id: commandId },
        data: body,
      });

      await markDatabaseTypeCustomized(id);

      await logAudit({
        action: 'update',
        resourceType: 'database_type_command',
        resourceId: command.id,
        resourceName: `${existing.databaseType.name}/${command.name}`,
        details: body,
        userId: request.authUser!.id,
      });

      return { command };
    }
  );

  // Delete a database type command (admin only)
  fastify.delete(
    '/api/settings/database-types/:id/commands/:commandId',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id, commandId } = request.params as { id: string; commandId: string };

      const existing = await findOrNotFound(prisma.databaseTypeCommand.findFirst({
        where: { id: commandId, databaseTypeId: id },
        include: { databaseType: true },
      }), 'Command', reply);
      if (!existing) return;

      await prisma.databaseTypeCommand.delete({ where: { id: commandId } });

      await markDatabaseTypeCustomized(id);

      await logAudit({
        action: 'delete',
        resourceType: 'database_type_command',
        resourceId: commandId,
        resourceName: `${existing.databaseType.name}/${existing.name}`,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );
}
