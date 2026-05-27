import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createUser,
  validatePassword,
} from '../services/auth.js';
import { validateBody } from '../lib/helpers.js';
import { computeScopes } from '../lib/scopes.js';
import { prisma } from '../lib/db.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
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
      const authUser = request.authUser!;

      // environments[]: scoped tokens advertise their allowlist; JWT/full-access
      // tokens get the complete list of environment IDs they can see.
      let environments: string[];
      if (authUser.scope && !authUser.scope.allEnvironments) {
        environments = authUser.scope.environmentIds;
      } else {
        const rows = await prisma.environment.findMany({ select: { id: true } });
        environments = rows.map((e) => e.id);
      }

      const scopes = computeScopes(authUser);

      // ADDITIVE: existing `user` field is preserved verbatim so existing
      // clients keep working. New fields `role`, `environments`, `scopes`
      // are added at the top level.
      return {
        user: authUser,
        role: authUser.role,
        environments,
        scopes,
      };
    }
  );
}
