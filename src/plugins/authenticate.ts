import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { validateApiToken, getUserById, type AuthUser } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

async function authenticatePlugin(fastify: FastifyInstance) {
  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7);

          // Try API token first
          const user = await validateApiToken(token);
          if (user) {
            request.authUser = user;
            return;
          }

          // Try JWT
          try {
            const payload = await request.jwtVerify<{ id: string; email: string }>();
            // Fetch full user to get role
            const fullUser = await getUserById(payload.id);
            if (fullUser) {
              request.authUser = fullUser;
              return;
            }
          } catch {
            // Invalid JWT
          }
        }

        reply.code(401).send({ error: 'Unauthorized' });
      } catch {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    }
  );
}

// Use fastify-plugin to expose decorator to parent scope
export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['@fastify/jwt'],
});
