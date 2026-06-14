import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuditLogs } from '../services/audit.js';
import { parsePaginationQuery } from '../lib/helpers.js';
import { routeSchema } from '../lib/openapi-schema.js';

// Documents the audit-log filters + pagination. All fields are optional with
// coerced numerics so the runtime read (parsePaginationQuery + raw filter
// strings) stays non-rejecting and behaves exactly as before — this only adds
// the OpenAPI contract, it does not validate at runtime.
const auditLogsQuerySchema = z.object({
  environmentId: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().min(0).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  // List audit logs
  fastify.get(
    '/api/audit-logs',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'List audit logs with optional filters and pagination',
        querystring: auditLogsQuerySchema,
        errors: [401],
      }),
    },
    async (request) => {
      const {
        environmentId,
        resourceType,
        resourceId,
        action,
      } = request.query as {
        environmentId?: string;
        resourceType?: string;
        resourceId?: string;
        action?: string;
      };

      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>, { limit: 50, offset: 0 });

      const result = await getAuditLogs({
        environmentId,
        resourceType,
        resourceId,
        action,
        limit,
        offset,
      });

      return result;
    }
  );
}
