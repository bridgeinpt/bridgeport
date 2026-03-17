import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/db.js';
import { requireAdmin, requireAdminOrSelf } from '../plugins/authorize.js';
import { logAudit } from '../services/audit.js';
import type { UserRole } from '../services/auth.js';
import { send, NOTIFICATION_TYPES } from '../services/notifications.js';
import { getSystemSettings } from '../services/system-settings.js';
import { validateBody, findOrNotFound } from '../lib/helpers.js';

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
          lastActiveAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { users };
    }
  );

  // Get active users (admin only) - users active within configured window
  fastify.get(
    '/api/users/active',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async () => {
      const settings = await getSystemSettings();
      const activeWindowMs = settings.activeUserWindowMin * 60 * 1000;
      const cutoffTime = new Date(Date.now() - activeWindowMs);
      const activeUsers = await prisma.user.findMany({
        where: {
          lastActiveAt: { gte: cutoffTime },
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          lastActiveAt: true,
        },
        orderBy: { lastActiveAt: 'desc' },
      });

      return { activeUsers };
    }
  );

  // Get single user (admin or self)
  fastify.get(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireAdminOrSelf('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const user = await findOrNotFound(prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }), 'User', reply);
      if (!user) return;

      return { user };
    }
  );

  // Create user (admin only)
  fastify.post(
    '/api/users',
    { preHandler: [fastify.authenticate, requireAdmin] },
    async (request, reply) => {
      const body = validateBody(createUserSchema, request, reply);
      if (!body) return;

      // Check if email already exists
      const existing = await prisma.user.findUnique({
        where: { email: body.email },
      });

      if (existing) {
        return reply.code(409).send({ error: 'Email already in use' });
      }

      const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

      const user = await prisma.user.create({
        data: {
          email: body.email,
          passwordHash,
          name: body.name,
          role: body.role,
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

      // Send notification to the new user
      await send(NOTIFICATION_TYPES.USER_ACCOUNT_CREATED, user.id, {});

      return { user };
    }
  );

  // Update user (admin can update anyone, users can update their own name only)
  fastify.patch(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireAdminOrSelf('id')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateUserSchema, request, reply);
      if (!body) return;

      const existingUser = await findOrNotFound(prisma.user.findUnique({
        where: { id },
      }), 'User', reply);
      if (!existingUser) return;

      // Non-admins cannot change roles
      const isAdmin = request.authUser!.role === 'admin';
      if (!isAdmin && body.role) {
        return reply.code(403).send({ error: 'Only admins can change user roles' });
      }

      const updateData: { name?: string; role?: UserRole } = {};
      if (body.name !== undefined) {
        updateData.name = body.name;
      }
      if (body.role !== undefined && isAdmin) {
        updateData.role = body.role;
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

      // Notify user if role changed
      if (updateData.role && updateData.role !== existingUser.role) {
        await send(NOTIFICATION_TYPES.USER_ROLE_CHANGED, user.id, {
          oldRole: existingUser.role,
          newRole: updateData.role,
        });
      }

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

      const user = await findOrNotFound(prisma.user.findUnique({
        where: { id },
        select: { email: true },
      }), 'User', reply);
      if (!user) return;

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
      const body = validateBody(changePasswordSchema, request, reply);
      if (!body) return;

      const user = await findOrNotFound(prisma.user.findUnique({
        where: { id },
      }), 'User', reply);
      if (!user) return;

      const isAdmin = request.authUser!.role === 'admin';
      const isSelf = request.authUser!.id === id;

      // Non-admins changing their own password must provide current password
      if (isSelf && !isAdmin) {
        if (!body.currentPassword) {
          return reply.code(400).send({ error: 'Current password is required' });
        }

        const validPassword = await bcrypt.compare(body.currentPassword, user.passwordHash);
        if (!validPassword) {
          return reply.code(401).send({ error: 'Current password is incorrect' });
        }
      }

      const newPasswordHash = await bcrypt.hash(body.newPassword, SALT_ROUNDS);

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

      // Notify user that password was changed
      await send(NOTIFICATION_TYPES.USER_PASSWORD_CHANGED, id, {
        changedBy: isAdmin && !isSelf ? ' by an administrator' : '',
      });

      return { success: true, message: 'Password updated successfully' };
    }
  );
}
