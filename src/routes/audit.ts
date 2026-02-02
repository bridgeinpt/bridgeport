import type { FastifyInstance } from 'fastify';
import { getAuditLogs } from '../services/audit.js';

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
        limit,
        offset,
      } = request.query as {
        environmentId?: string;
        resourceType?: string;
        resourceId?: string;
        action?: string;
        limit?: string;
        offset?: string;
      };

      const result = await getAuditLogs({
        environmentId,
        resourceType,
        resourceId,
        action,
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0,
      });

      return result;
    }
  );
}
