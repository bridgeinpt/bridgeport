/**
 * Fastify plugin that mounts the MCP (Model Context Protocol) server at
 * POST /mcp (issue #208).
 *
 * Registered ONLY when `config.MCP_ENABLED` is true (see src/server.ts). When
 * disabled the route does not exist, so /mcp returns 404.
 *
 * Transport model: STATELESS. Per incoming POST we build a fresh McpServer for
 * the authenticated caller and a `StreamableHTTPServerTransport` with
 * `sessionIdGenerator: undefined`, connect them, hand the raw Node req/res to
 * `transport.handleRequest`, and tear both down when the response closes. There
 * is no session store — v1 is tools-only (no resources/prompts/subscriptions).
 *
 * Auth: the route uses `fastify.authenticate` as a preHandler, so the same
 * bearer token (API token or JWT) that authenticates REST calls authenticates
 * the MCP connection and populates `request.authUser`. The caller's raw bearer
 * is forwarded on every injected API call so per-route role/scope checks run
 * identically.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { buildMcpServer } from './server.js';

/**
 * Allowed Host header values for the transport's optional DNS-rebinding
 * protection, parsed from the explicit `MCP_ALLOWED_HOSTS` config (a
 * comma-separated list of the PUBLIC hostnames clients reach /mcp through —
 * e.g. "mcp.example.com").
 *
 * This is deliberately decoupled from `HOST` (the socket BIND address):
 * conflating the two meant a concrete HOST rejected clients arriving via a
 * reverse proxy / public hostname, while the common Docker default
 * HOST=0.0.0.0 silently turned protection off. Returns `undefined` when the
 * config is unset/empty, leaving protection OFF — the endpoint is
 * bearer-authenticated, and an empty allowlist would break every client.
 * Documented in docs/reference/mcp.md.
 */

/**
 * Parse the comma-separated `MCP_ALLOWED_HOSTS` raw string into a trimmed,
 * non-empty list of hostnames. Shared by the transport's `buildAllowedHosts`
 * (here) AND the admin status page (`src/routes/admin/mcp.ts`) so the page reports
 * exactly the hosts the transport's DNS-rebinding protection enforces — a single
 * parser, so the two can't drift. Returns `[]` when unset/empty.
 */
export function parseMcpAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function buildAllowedHosts(): string[] | undefined {
  const hosts = parseMcpAllowedHosts(config.MCP_ALLOWED_HOSTS);
  return hosts.length > 0 ? hosts : undefined;
}

async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  const allowedHosts = buildAllowedHosts();

  fastify.post(
    '/mcp',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      // authenticate() guarantees a valid principal; this also satisfies TS.
      if (!authHeader?.startsWith('Bearer ') || !request.authUser) {
        throw new ApiError('UNAUTHORIZED', 'Unauthorized');
      }
      const bearer = authHeader.slice(7);

      // The caller's real client IP, threaded onto every injected sub-call so
      // @fastify/rate-limit buckets them under THIS caller's IP (not the
      // light-my-request default of 127.0.0.1, which would share one bucket
      // across all MCP callers). See src/mcp/inject.ts.
      const callerIp = request.ip;

      const server = buildMcpServer({ app: fastify, authUser: request.authUser, bearer, callerIp });
      const transport = new StreamableHTTPServerTransport({
        // Stateless: no session id, no session validation, no in-memory state.
        sessionIdGenerator: undefined,
        // DNS-rebinding protection — enabled only when MCP_ALLOWED_HOSTS is set
        // (see buildAllowedHosts). When `allowedHosts` is undefined the SDK
        // leaves host validation off.
        enableDnsRebindingProtection: allowedHosts !== undefined,
        ...(allowedHosts ? { allowedHosts } : {}),
      });

      // Tear down both the transport and the server when the underlying socket
      // closes (request handled, client disconnect, or error). Idempotent.
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        transport.close().catch(() => {});
        server.close().catch(() => {});
      };
      reply.raw.on('close', cleanup);

      // The SDK transport writes the HTTP response (and possibly an SSE stream)
      // directly to the raw Node response, so tell Fastify we've taken over.
      reply.hijack();

      try {
        await server.connect(transport);
        // Pass the already-parsed body so the transport doesn't try to re-read
        // the stream (Fastify's JSON parser already consumed it).
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        request.log.error({ err }, 'MCP request handling failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            })
          );
        }
        cleanup();
      }
    }
  );

  // Stateless server: GET (SSE stream) and DELETE (session teardown) are not
  // supported. Return 405 with the canonical envelope so clients fail fast
  // instead of hanging on an unanswered stream.
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(405)
      .header('allow', 'POST')
      .send({ code: 'VALIDATION_ERROR', message: 'Method Not Allowed: the MCP endpoint is stateless and only accepts POST.' });
  };
  fastify.get('/mcp', { preHandler: [fastify.authenticate] }, methodNotAllowed);
  fastify.delete('/mcp', { preHandler: [fastify.authenticate] }, methodNotAllowed);
}

// fastify-plugin so the route is registered on the ROOT instance (it needs the
// root `app.inject` to replay API calls against the real routes), not an
// encapsulated child context.
export default fp(mcpRoutes, {
  name: 'mcp',
  dependencies: ['authenticate'],
});
