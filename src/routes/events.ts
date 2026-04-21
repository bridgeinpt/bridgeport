import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eventBus, type BRIDGEPORTEvent } from '../lib/event-bus.js';
import { validateApiToken, getUserById } from '../services/auth.js';

export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token, environmentId } = request.query as { token?: string; environmentId?: string };

      if (!token) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      // Authenticate via query param token (EventSource cannot send headers)
      // Try API token first, then JWT
      let userId: string | null = null;

      const apiUser = await validateApiToken(token);
      if (apiUser) {
        userId = apiUser.id;
      } else {
        // Try JWT verification
        try {
          const decoded = fastify.jwt.verify<{ id: string; email: string }>(token);
          const fullUser = await getUserById(decoded.id);
          if (fullUser) {
            userId = fullUser.id;
          }
        } catch {
          // Invalid JWT
        }
      }

      if (!userId) {
        return reply.code(401).send({ error: 'Unauthorized' });
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
