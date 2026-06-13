/**
 * buildMcpServer — assemble a per-request McpServer instance for a caller
 * (issue #208).
 *
 * The transport is stateless (one McpServer per incoming POST), so this is
 * called fresh for every request. It computes the caller's scopes via
 * `computeScopes` and registers ONLY the tools whose `requiredScope` is null
 * or present in those scopes — so an env-scoped viewer token sees the read +
 * meta tools, while an operator/admin token additionally sees the write tools.
 *
 * Each tool's handler runs `injectApi` under the hood (see tools.ts) and maps
 * the API envelope to an MCP result; on a non-2xx / ApiError envelope it returns
 * `{ isError: true, content: [{ type: 'text', text: "<code>: <message>" }] }`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { computeScopes } from '../lib/scopes.js';
import { appVersion } from '../lib/version.js';
import type { AuthUser } from '../services/auth.js';
import { ALL_TOOLS } from './tools.js';
import type { McpToolContext, McpToolDef } from './types.js';

export interface BuildMcpServerOptions {
  /** Root Fastify instance (the one whose routes the tools inject into). */
  app: FastifyInstance;
  authUser: AuthUser;
  /** Raw bearer token (without "Bearer " prefix) of the MCP caller. */
  bearer: string;
}

/**
 * Select the tools a caller holding `scopes` is entitled to: every meta/read
 * tool (`requiredScope === null`, available to any valid token) plus any write
 * tool whose required scope is present. Pure and side-effect-free so the
 * scope-gating contract can be unit-tested without the SDK or a transport.
 */
export function selectToolsForScopes(scopes: string[]): McpToolDef[] {
  const scopeSet = new Set(scopes);
  return ALL_TOOLS.filter(
    (tool) => tool.requiredScope === null || scopeSet.has(tool.requiredScope)
  );
}

/**
 * Build (but do not connect) an McpServer with the tools this caller is
 * entitled to. The caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(options: BuildMcpServerOptions): McpServer {
  const { app, authUser, bearer } = options;

  const server = new McpServer({
    name: 'bridgeport',
    version: appVersion,
  });

  // Tools available to this session: meta/read (requiredScope null) plus any
  // write tool whose required scope the caller holds.
  const availableTools = selectToolsForScopes(computeScopes(authUser));
  const registeredToolNames = availableTools.map((t) => t.name);

  const ctx: McpToolContext = { app, bearer, authUser, registeredToolNames };

  for (const tool of availableTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
        },
      },
      // The SDK validates args against inputSchema before invoking, so `args`
      // is the parsed shape; we widen to Record for the declarative handler.
      // McpToolResult is structurally a CallToolResult (content + isError); the
      // cast supplies the SDK's permissive index signature.
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const result = await tool.handler(args ?? {}, ctx);
        return result as CallToolResult;
      }
    );
  }

  return server;
}
