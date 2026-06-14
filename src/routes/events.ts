import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eventBus, type BRIDGEPORTEvent } from '../lib/event-bus.js';
import { validateApiToken, getUserById, type AuthUser } from '../services/auth.js';
import { routeSchema } from '../lib/openapi-schema.js';

// Documents the SSE query params. `token` carries the bearer (EventSource can't
// send headers) and `environmentId` optionally pins the stream to one env. Both
// are optional in the spec — the handler keeps its own 401/403 checks, so the
// runtime contract is unchanged.
const eventsQuerySchema = z.object({
  token: z.string().optional(),
  environmentId: z.string().optional(),
});

export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/events',
    {
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Subscribe to the server-sent events stream',
        querystring: eventsQuerySchema,
        errors: [401, 403],
      }),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token, environmentId } = request.query as { token?: string; environmentId?: string };

      if (!token) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      // Authenticate via query param token (EventSource cannot send headers)
      // Try API token first, then JWT
      let authUser: AuthUser | null = null;

      const apiUser = await validateApiToken(token);
      if (apiUser) {
        authUser = apiUser;
      } else {
        try {
          const decoded = fastify.jwt.verify<{ id: string; email: string }>(token);
          const fullUser = await getUserById(decoded.id);
          if (fullUser) {
            authUser = fullUser;
          }
        } catch {
          // Invalid JWT
        }
      }

      if (!authUser) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const userId = authUser.id;

      // Env-scoped tokens may only subscribe to envs in their allowlist, and a
      // subscription with no environmentId leaks events from every env, so an
      // env-scoped token must always pin to one (in-scope) env.
      const tokenScope = authUser.scope;
      if (tokenScope && !tokenScope.allEnvironments) {
        if (!environmentId) {
          return reply.code(403).send({
            error: 'Token is scoped to specific environments; environmentId query parameter is required',
          });
        }
        if (!tokenScope.environmentIds.includes(environmentId)) {
          return reply.code(403).send({ error: 'Token is not scoped to this environment' });
        }
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      // Send initial keepalive
      reply.raw.write(':ok\n\n');

      // Keepalive every 30 seconds
      const keepalive = setInterval(() => {
        reply.raw.write(':keepalive\n\n');
      }, 30000);

      const onEvent = (event: BRIDGEPORTEvent) => {
        // Filter by environment if specified
        if (environmentId && 'environmentId' in event.data && event.data.environmentId !== environmentId) {
          return;
        }
        // Filter notification events to only send to the target user
        if (event.type === 'notification' && event.data.userId !== userId) {
          return;
        }

        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
      };

      eventBus.on('event', onEvent);

      // Cleanup on disconnect
      request.raw.on('close', () => {
        clearInterval(keepalive);
        eventBus.off('event', onEvent);
      });
    }
  );
}
