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
 * Env-scoped API tokens (`scope.allEnvironments === false`) additionally have
 * write tools withheld: every write tool targets a GLOBAL route (no `:envId`),
 * which enforceTokenScope rejects with FORBIDDEN_SCOPE for any env-scoped token,
 * so advertising them would only ever produce guaranteed failures.
 *
 * Each tool's handler runs `injectApi` under the hood (see tools.ts) and maps
 * the API envelope to an MCP result; on a non-2xx / ApiError envelope it returns
 * `{ isError: true, content: [{ type: 'text', text: "<code>: <message> | ..." }] }`.
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
  /** The caller's real client IP (`request.ip`), threaded onto injected calls. */
  callerIp: string;
}

/**
 * Select the tools a caller holding `scopes` is entitled to: every meta/read
 * tool (`requiredScope === null`, available to any valid token) plus any write
 * tool whose required scope is present. Pure and side-effect-free so the
 * scope-gating contract can be unit-tested without the SDK or a transport.
 *
 * When `isEnvScoped` is true (an env-scoped API token), write tools are excluded
 * even if the role-derived scope is present: their global routes always fail
 * enforceTokenScope for an env-scoped token, so they'd be dead weight.
 */
export function selectToolsForScopes(scopes: string[], isEnvScoped = false): McpToolDef[] {
  const scopeSet = new Set(scopes);
  return ALL_TOOLS.filter((tool) => {
    if (tool.requiredScope === null) return true; // meta/read — always available
    if (!scopeSet.has(tool.requiredScope)) return false;
    // Env-scoped tokens can't reach the global write routes — hide write tools.
    if (isEnvScoped && tool.requiredScope.endsWith(':write')) return false;
    return true;
  });
}

/**
 * Build (but do not connect) an McpServer with the tools this caller is
 * entitled to. The caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(options: BuildMcpServerOptions): McpServer {
  const { app, authUser, bearer, callerIp } = options;

  const server = new McpServer({
    name: 'bridgeport',
    version: appVersion,
  });

  // An env-scoped API token has `scope.allEnvironments === false`. JWT sessions
  // (scope === undefined) and all-environment tokens are NOT env-scoped, so they
  // keep full write access. Env-scoped tokens get write tools withheld (their
  // global routes always FORBIDDEN_SCOPE — see selectToolsForScopes).
  const isEnvScoped = authUser.scope?.allEnvironments === false;

  // Tools available to this session: meta/read (requiredScope null) plus any
  // write tool whose required scope the caller holds (and, for env-scoped
  // tokens, that isn't a write tool).
  const availableTools = selectToolsForScopes(computeScopes(authUser), isEnvScoped);
  const registeredToolNames = availableTools.map((t) => t.name);

  const ctx: McpToolContext = { app, bearer, authUser, callerIp, registeredToolNames };

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
