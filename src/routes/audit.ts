import type { FastifyInstance } from 'fastify';
import { getAuditLogs } from '../services/audit.js';

export async function auditRoutes(fastify: FastifyInstance) {
  // List audit logs
  fastify.get(
    '/api/audit-logs',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const {
        environmentId,
        resourceType,
        action,
        limit,
        offset,
      } = request.query as {
        environmentId?: string;
        resourceType?: string;
        action?: string;
        limit?: string;
        offset?: string;
      };

      const result = await getAuditLogs({
        environmentId,
        resourceType,
        action,
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0,
      });

      return result;
    }
  );
}
