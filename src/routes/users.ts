import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db.js';
import { requireAdmin, requireAdminOrSelf } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import type { UserRole } from '../services/auth.js';

const SALT_ROUNDS = 12;

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
});

const updateUserSchema = z.object({
  name: z.string().optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(), // Required for self, optional for admin
  newPassword: z.string().min(8),
});

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // List all users (admin only)
  fastify.get(
    '/api/users',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { users };
    }
  );

  // Get single user (admin or self)
  fastify.get(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireAdminOrSelf('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return { user };
    }
  );

  // Create user (admin only)
  fastify.post(
    '/api/users',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = createUserSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      // Check if email already exists
      const existing = await prisma.user.findUnique({
        where: { email: body.data.email },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Email already in use' });
      }

      const passwordHash = await bcrypt.hash(body.data.password, SALT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          email: body.data.email,
          passwordHash,
          name: body.data.name,
          role: body.data.role,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await logAudit({
        action: 'create',
        resourceType: 'user',
        resourceId: user.id,
        resourceName: user.email,
        details: { role: user.role },
        userId: request.authUser!.id,
      });

      return { user };
    }
  );

  // Update user (admin can update anyone, users can update their own name only)
  fastify.patch(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireAdminOrSelf('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateUserSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const existingUser = await prisma.user.findUnique({
        where: { id },
      });

      if (!existingUser) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Non-admins cannot change roles
      const isAdmin = request.authUser!.role === 'admin';
      if (!isAdmin && body.data.role) {
        return reply.code(403).send({ error: 'Only admins can change user roles' });
      }

      const updateData: { name?: string; role?: UserRole } = {};
      if (body.data.name !== undefined) {
        updateData.name = body.data.name;
      }
      if (body.data.role !== undefined && isAdmin) {
        updateData.role = body.data.role;
      }

      const user = await prisma.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'user',
        resourceId: user.id,
        resourceName: user.email,
        details: updateData,
        userId: request.authUser!.id,
      });

      return { user };
    }
  );

  // Delete user (admin only, cannot delete self)
  fastify.delete(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Cannot delete yourself
      if (id === request.authUser!.id) {
        return reply.code(400).send({ error: 'Cannot delete your own account' });
      }

      const user = await prisma.user.findUnique({
        where: { id },
        select: { email: true },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await prisma.user.delete({
        where: { id },
      });

      await logAudit({
        action: 'delete',
        resourceType: 'user',
        resourceId: id,
        resourceName: user.email,
        userId: request.authUser!.id,
      });

      return { success: true };
    }
  );

  // Change password (admin can change anyone's, users can change their own)
  fastify.post(
    '/api/users/:id/change-password',
    { preHandler: [fastify.authenticate, requireAdminOrSelf('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = changePasswordSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const user = await prisma.user.findUnique({
        where: { id },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const isAdmin = request.authUser!.role === 'admin';
      const isSelf = request.authUser!.id === id;

      // Non-admins changing their own password must provide current password
      if (isSelf && !isAdmin) {
        if (!body.data.currentPassword) {
          return reply.code(400).send({ error: 'Current password is required' });
        }

        const validPassword = await bcrypt.compare(body.data.currentPassword, user.passwordHash);
        if (!validPassword) {
          return reply.code(401).send({ error: 'Current password is incorrect' });
        }
      }

      const newPasswordHash = await bcrypt.hash(body.data.newPassword, SALT_ROUNDS);

      await prisma.user.update({
        where: { id },
        data: { passwordHash: newPasswordHash },
      });

      await logAudit({
        action: 'update',
        resourceType: 'user',
        resourceId: id,
        resourceName: user.email,
        details: { passwordChanged: true, changedBy: isAdmin && !isSelf ? 'admin' : 'self' },
        userId: request.authUser!.id,
      });

      return { success: true, message: 'Password updated successfully' };
    }
  );
}
