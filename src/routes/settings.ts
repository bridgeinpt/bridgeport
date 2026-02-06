import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
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

      const serviceType = await prisma.serviceType.findUnique({
        where: { id },
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { services: true },
          },
        },
      });

      if (!serviceType) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

      return { serviceType };
    }
  );

  // Create a service type (admin only)
  fastify.post(
    '/api/settings/service-types',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createServiceTypeSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.serviceType.findUnique({
        where: { name: body.data.name },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Service type already exists' });
      }

      const serviceType = await prisma.serviceType.create({
        data: {
          ...body.data,
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
      const body = updateServiceTypeSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.serviceType.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

      await markServiceTypeCustomized(id);

      const serviceType = await prisma.serviceType.update({
        where: { id },
        data: body.data,
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
        details: body.data,
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

      const existing = await prisma.serviceType.findUnique({
        where: { id },
        include: { _count: { select: { services: true } } },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

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

      const existing = await prisma.serviceType.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

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
      const body = createCommandSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const serviceType = await prisma.serviceType.findUnique({ where: { id } });
      if (!serviceType) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

      // Check for duplicate command name
      const existingCmd = await prisma.serviceTypeCommand.findUnique({
        where: {
          serviceTypeId_name: { serviceTypeId: id, name: body.data.name },
        },
      });

      if (existingCmd) {
        return reply.code(409).send({ error: 'Command already exists' });
      }

      // Get max sortOrder if not specified
      let sortOrder = body.data.sortOrder;
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
          ...body.data,
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
        details: { serviceTypeId: id, command: body.data.command },
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
      const body = updateCommandSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.serviceTypeCommand.findFirst({
        where: { id: commandId, serviceTypeId: id },
        include: { serviceType: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Command not found' });
      }

      const command = await prisma.serviceTypeCommand.update({
        where: { id: commandId },
        data: body.data,
      });

      await markServiceTypeCustomized(id);

      await logAudit({
        action: 'update',
        resourceType: 'service_type_command',
        resourceId: command.id,
        resourceName: `${existing.serviceType.name}/${command.name}`,
        details: body.data,
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

      const existing = await prisma.serviceTypeCommand.findFirst({
        where: { id: commandId, serviceTypeId: id },
        include: { serviceType: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Command not found' });
      }

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

      const serviceType = await prisma.serviceType.findUnique({ where: { id } });
      if (!serviceType) {
        return reply.code(404).send({ error: 'Service type not found' });
      }

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
          connectionFields: JSON.parse(dt.connectionFields),
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

      const databaseType = await prisma.databaseType.findUnique({
        where: { id },
        include: {
          commands: {
            orderBy: { sortOrder: 'asc' },
          },
          _count: {
            select: { databases: true },
          },
        },
      });

      if (!databaseType) {
        return reply.code(404).send({ error: 'Database type not found' });
      }

      return {
        databaseType: {
          ...databaseType,
          connectionFields: JSON.parse(databaseType.connectionFields),
        },
      };
    }
  );

  // Create a database type (admin only)
  fastify.post(
    '/api/settings/database-types',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createDatabaseTypeSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.databaseType.findUnique({
        where: { name: body.data.name },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Database type already exists' });
      }

      const databaseType = await prisma.databaseType.create({
        data: {
          name: body.data.name,
          displayName: body.data.displayName,
          source: 'user',
          connectionFields: JSON.stringify(body.data.connectionFields),
          backupCommand: body.data.backupCommand || null,
          restoreCommand: body.data.restoreCommand || null,
          defaultPort: body.data.defaultPort || null,
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
          connectionFields: JSON.parse(databaseType.connectionFields),
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
      const body = updateDatabaseTypeSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.databaseType.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Database type not found' });
      }

      await markDatabaseTypeCustomized(id);

      const updateData: Record<string, unknown> = {};
      if (body.data.displayName !== undefined) updateData.displayName = body.data.displayName;
      if (body.data.connectionFields !== undefined) updateData.connectionFields = JSON.stringify(body.data.connectionFields);
      if (body.data.backupCommand !== undefined) updateData.backupCommand = body.data.backupCommand;
      if (body.data.restoreCommand !== undefined) updateData.restoreCommand = body.data.restoreCommand;
      if (body.data.defaultPort !== undefined) updateData.defaultPort = body.data.defaultPort;

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
        details: body.data,
        userId: request.authUser!.id,
      });

      return {
        databaseType: {
          ...databaseType,
          connectionFields: JSON.parse(databaseType.connectionFields),
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

      const existing = await prisma.databaseType.findUnique({
        where: { id },
        include: { _count: { select: { databases: true } } },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Database type not found' });
      }

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

      const existing = await prisma.databaseType.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'Database type not found' });
      }

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
          connectionFields: JSON.parse(databaseType.connectionFields),
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
      const body = createCommandSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const databaseType = await prisma.databaseType.findUnique({ where: { id } });
      if (!databaseType) {
        return reply.code(404).send({ error: 'Database type not found' });
      }

      const existingCmd = await prisma.databaseTypeCommand.findUnique({
        where: {
          databaseTypeId_name: { databaseTypeId: id, name: body.data.name },
        },
      });

      if (existingCmd) {
        return reply.code(409).send({ error: 'Command already exists' });
      }

      let sortOrder = body.data.sortOrder;
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
          ...body.data,
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
        details: { databaseTypeId: id, command: body.data.command },
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
      const body = updateCommandSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existing = await prisma.databaseTypeCommand.findFirst({
        where: { id: commandId, databaseTypeId: id },
        include: { databaseType: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Command not found' });
      }

      const command = await prisma.databaseTypeCommand.update({
        where: { id: commandId },
        data: body.data,
      });

      await markDatabaseTypeCustomized(id);

      await logAudit({
        action: 'update',
        resourceType: 'database_type_command',
        resourceId: command.id,
        resourceName: `${existing.databaseType.name}/${command.name}`,
        details: body.data,
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

      const existing = await prisma.databaseTypeCommand.findFirst({
        where: { id: commandId, databaseTypeId: id },
        include: { databaseType: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Command not found' });
      }

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
