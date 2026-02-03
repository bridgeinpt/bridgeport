import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAdmin } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';

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

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
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
        data: body.data,
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
}
