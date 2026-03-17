import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createUser,
  validatePassword,
  createApiToken,
  listApiTokens,
  deleteApiToken,
} from '../services/auth.js';
import { send, NOTIFICATION_TYPES } from '../services/notifications.js';
import { validateBody } from '../lib/helpers.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const createTokenSchema = z.object({
  name: z.string().min(1),
  expiresInDays: z.number().optional(),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // Login
  fastify.post('/api/auth/login', async (request, reply) => {
    const body = validateBody(loginSchema, request, reply);
    if (!body) return;

    const user = await validatePassword(body.email, body.password);
    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = fastify.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: '7d' }
    );

    return { token, user };
  });

  // Register (only if no users exist)
  fastify.post('/api/auth/register', async (request, reply) => {
    const body = validateBody(registerSchema, request, reply);
    if (!body) return;

    // Check if users exist (only allow first user registration)
    const { prisma } = await import('../lib/db.js');
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return reply.code(403).send({ error: 'Registration disabled' });
    }

    // First user is always admin
    const user = await createUser(body.email, body.password, body.name, 'admin');

    const token = fastify.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: '7d' }
    );

    return { token, user };
  });

  // Get current user
  fastify.get(
    '/api/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      return { user: request.authUser };
    }
  );

  // List API tokens
  fastify.get(
    '/api/auth/tokens',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const tokens = await listApiTokens(request.authUser!.id);
      return { tokens };
    }
  );

  // Create API token
  fastify.post(
    '/api/auth/tokens',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = validateBody(createTokenSchema, request, reply);
      if (!body) return;

      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const { token, tokenRecord } = await createApiToken(
        request.authUser!.id,
        body.name,
        expiresAt
      );

      // Notify user about API token creation
      await send(NOTIFICATION_TYPES.USER_API_TOKEN_CREATED, request.authUser!.id, {
        tokenName: body.name,
      });

      // Only return the full token once
      return {
        token,
        tokenRecord: {
          id: tokenRecord.id,
          name: tokenRecord.name,
          expiresAt: tokenRecord.expiresAt,
          createdAt: tokenRecord.createdAt,
        },
      };
    }
  );

  // Delete API token
  fastify.delete(
    '/api/auth/tokens/:tokenId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { tokenId } = request.params as { tokenId: string };
      const deleted = await deleteApiToken(tokenId, request.authUser!.id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      return { success: true };
    }
  );
}
