import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../plugins/authorize.js';
import { routeSchema } from '../../lib/openapi-schema.js';
import { config } from '../../lib/config.js';
import { listToolMetadata } from '../../mcp/tools.js';
import { listResourceMetadata } from '../../mcp/resources.js';

/**
 * Parse the comma-separated `MCP_ALLOWED_HOSTS` config into a trimmed,
 * non-empty list. Mirrors `buildAllowedHosts` in src/mcp/plugin.ts so the status
 * page reports the SAME hosts the transport's DNS-rebinding protection actually
 * enforces. Returns `[]` when unset/empty (protection off).
 */
function parseAllowedHosts(): string[] {
  const raw = config.MCP_ALLOWED_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

export async function mcpAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // Admin-only. Returns STATIC MCP inventory + the env-derived enabled/security
  // state so an admin can see what the /mcp endpoint exposes and how to enable
  // and connect to it — WHETHER OR NOT MCP is currently enabled (the metadata is
  // read from the in-process registries, not the live transport). Enable/disable
  // is intentionally NOT a UI toggle: it is controlled by MCP_ENABLED at startup.
  fastify.get(
    '/api/admin/mcp',
    {
      preHandler: [fastify.authenticate, requireAdmin],
      schema: routeSchema({
        tags: ['admin'],
        summary: 'Get MCP server status and exposed tool/resource inventory',
        errors: [401, 403],
      }),
    },
    async () => {
      const tools = listToolMetadata();
      const resources = listResourceMetadata();
      const allowedHosts = parseAllowedHosts();

      const readTools = tools.filter((t) => t.readOnly).length;
      const writeTools = tools.length - readTools;

      return {
        enabled: config.MCP_ENABLED,
        endpointPath: '/mcp',
        dnsRebindingProtection: {
          configured: allowedHosts.length > 0,
          allowedHosts,
        },
        tools,
        resources,
        counts: {
          tools: tools.length,
          readTools,
          writeTools,
          resources: resources.length,
        },
      };
    }
  );
}
