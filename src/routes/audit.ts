import type { FastifyInstance } from 'fastify';
import { getAuditLogs } from '../services/audit.js';
import { parsePaginationQuery } from '../lib/helpers.js';

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  // List audit logs
  fastify.get(
    '/api/audit-logs',
    { preHandler: [fastify.authenticate] },
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
